// scripts/pull_telemetry.mjs
// Node 20+ (ESM). Schreibt data/latest.json und hängt Zeilen an data/lhc_history.jsonl an.

import fs from "node:fs/promises";

// ---- ENV (aus Workflow) --------------------------------------------------------
const ENERGY_URL  = process.env.ENERGY_URL  || "";   // Pflicht
const IB1_URL     = process.env.IB1_URL     || "";   // optional
const IB2_URL     = process.env.IB2_URL     || "";   // optional
const LUMI_URL    = process.env.LUMI_URL    || "";   // optional
const FORCE_SPEC  = (process.env.FORCE_SPECIES || "").trim().toLowerCase(); // "", "protons", "ions"

// ---- Dateien -------------------------------------------------------------------
const DIR             = "data";
const LATEST_PATH     = `${DIR}/latest.json`;
const HISTORY_PATH    = `${DIR}/lhc_history.jsonl`;
const STATE_PATH      = `${DIR}/.state.json`; // nur für "last known species"

// ---- Helpers -------------------------------------------------------------------
function parseNumber(x) {
  if (x == null) return null;
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const as = String(x).replace(",", ".");
  const n = parseFloat(as);
  return Number.isFinite(n) ? n : null;
}

// Tiefen-Suche: irgendein Feld, das wie Energie/Intensität/Lumi aussieht
function pickByRegex(obj, rx) {
  const q = [obj];
  while (q.length) {
    const o = q.shift();
    if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        if (rx.test(k)) {
          if (typeof v === "number") return v;
          const n = parseNumber(v?.value ?? v);
          if (n != null) return n;
        }
        if (v && typeof v === "object") q.push(v);
      }
    }
  }
  return null;
}

async function fetchNum(url, rx) {
  if (!url) return null;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await r.json();
    const n = pickByRegex(j, rx);
    return n != null ? n : parseNumber(j);
  } else {
    const t = await r.text();
    return parseNumber(t);
  }
}

// Proton-β aus Gesamtenergie (GeV) per γ = E/m0, m0≈0.938 GeV
function betaFromProtonGeV(E) {
  const m0 = 0.9382720813;
  if (!(E > 0)) return 0;
  const gamma = E / m0;
  const b2 = 1 - 1 / (gamma * gamma);
  return Math.sqrt(Math.max(0, Math.min(1, b2)));
}

async function readLastSpecies() {
  try {
    const txt = await fs.readFile(STATE_PATH, "utf8");
    const j = JSON.parse(txt);
    return (j && j.species) || "unknown";
  } catch {
    return "unknown";
  }
}

async function writeLastSpecies(species) {
  try {
    await fs.writeFile(STATE_PATH, JSON.stringify({ species }, null, 2) + "\n");
  } catch {}
}

/**
 * Heuristik zur Art:
 *  - HARDCODED OVERRIDE via FORCE_SPECIES
 *  - klare Protonen-Signatur: E >= 4.0 TeV
 *  - klare Ionen-Signatur:    E <= 3.5 TeV UND sehr niedrige Intensitäten
 *  - sonst: nutze "last known", fallbacks auf "protons"
 *
 * Hinweis: LHC zeigt Energie häufig als protonäquivalente GeV.
 * Für Pb82+ gilt pro Nukleon ~0.394 * E_proton; Ionen-Läufe liegen typ. ~2.5–3.0 TeV/Nukleon.
 */
function speciesFromSample(sample, lastKnown = "unknown") {
  // 1) Override
  if (FORCE_SPEC === "proton" || FORCE_SPEC === "protons") return "protons";
  if (FORCE_SPEC === "ion" || FORCE_SPEC === "ions") return "ions";

  const E = sample.energy; // GeV (protonäquivalent)
  const I = Math.max(sample.ib1 || 0, sample.ib2 || 0);

  // 2) klare Protonen-Signatur bei hohen Energien
  if (E != null && E >= 4000) return "protons";

  // 3) klare Ionen-Signatur bei niedrigeren Energien + geringer Intensität
  if (E != null && E <= 3500 && I > 0 && I < 1e12) return "ions";

  // 4) reine Intensitätsheuristik, falls E fehlt
  if (I > 1e13) return "protons";
  if (I > 0 && I < 5e11) return "ions";

  // 5) Beibehaltung statt Springen ins Falsche
  if (lastKnown && lastKnown !== "unknown") return lastKnown;

  // 6) Konservativer Default: Protons (häufigster Run)
  return "protons";
}

async function appendHistoryLine(obj) {
  const line = JSON.stringify(obj);
  await fs.appendFile(HISTORY_PATH, line + "\n");
}

async function main() {
  await fs.mkdir(DIR, { recursive: true });

  // Vorheriger Species-Zustand für stabile Entscheidung
  const lastKnown = await readLastSpecies();

  // Zugriffe
  const [energyGeV, ib1, ib2, lumi] = await Promise.all([
    fetchNum(ENERGY_URL, /(energy|beam.?energy)/i),
    fetchNum(IB1_URL, /(ib1|beam.?1.*(intensity|current))/i),
    fetchNum(IB2_URL, /(ib2|beam.?2.*(intensity|current))/i),
    fetchNum(LUMI_URL, /(lumi|luminosit)/i),
  ]);

  const t = Math.floor(Date.now() / 1000);

  const sample = {
    t,
    energy: energyGeV ?? null,
    speed: energyGeV != null ? betaFromProtonGeV(energyGeV) : null,
    ib1: ib1 ?? null,
    ib2: ib2 ?? null,
    lumi: lumi ?? null,
  };

  // Art bestimmen
  const species = speciesFromSample(sample, lastKnown);
  sample.species = species;

  // Dateien schreiben
  await fs.writeFile(LATEST_PATH, JSON.stringify(sample, null, 2) + "\n");
  await appendHistoryLine(sample);
  await writeLastSpecies(species);

  console.log(
    `OK ${new Date(t * 1000).toISOString()} · E=${sample.energy ?? "–"} GeV · β=${sample.speed ?? "–"} · I=[${sample.ib1 ?? "–"}, ${sample.ib2 ?? "–"}] · L=${sample.lumi ?? "–"} · species=${species}`
  );
}

main().catch((e) => {
  console.error("[pull_telemetry] failed:", e);
  process.exit(1);
});
