// Node 20+: native fetch
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const LATEST = path.join(DATA_DIR, "latest.json");
const HISTORY = path.join(DATA_DIR, "lhc_history.jsonl");

const ENERGY_URL = process.env.ENERGY_URL || "";
const IB1_URL    = process.env.IB1_URL || "";
const IB2_URL    = process.env.IB2_URL || "";
const LUMI_URL   = process.env.LUMI_URL || ""; // optional
const FORCE_SPECIES = (process.env.FORCE_SPECIES || "").toLowerCase().trim();
const MOCK = process.env.MOCK === "1";

// ---------- helpers ------------------------------------------------------------
const ensureDir = p => fs.existsSync(p) || fs.mkdirSync(p, { recursive: true });

const num = (x) => {
  if (x == null) return null;
  const n = typeof x === "number" ? x : parseFloat(String(x).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

// pick first numeric value whose key matches rx (deep)
function pickByRegex(obj, rx) {
  const q = [obj];
  while (q.length) {
    const o = q.shift();
    if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        if (rx.test(k)) {
          if (typeof v === "number") return v;
          const n = num(v?.value ?? v);
          if (n != null) return n;
        }
        if (v && typeof v === "object") q.push(v);
      }
    }
  }
  return null;
}

function betaFromGeV(E) {
  // Proton-Ruhemasse ~ 0.9382720813 GeV (pro Nukleon)
  const m0 = 0.9382720813;
  const gamma = E && E > 0 ? (E / m0) : 1;
  if (gamma <= 1) return 0;
  const b2 = 1 - 1 / (gamma * gamma);
  return Math.sqrt(Math.max(0, Math.min(1, b2)));
}

function guessSpeciesFromPayload(...objs) {
  // Sehr konservativ: suche Hinweise in Strings/Keys/Flags
  const hay = JSON.stringify(objs).toLowerCase();
  if (/ion|pb|lead|a-ion|heavy/.test(hay)) return "ions";
  if (/proton|p\-beam|pbeam/.test(hay)) return "protons";
  return null;
}

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return await r.json();
}

// ---------- mock fallback ------------------------------------------------------
async function readMock() {
  const now = Math.floor(Date.now() / 1000);
  const baseE = 6800; // GeV
  const jitter = (amt) => (Math.random() - 0.5) * amt;
  const energy = baseE + jitter(50);
  const ib1 = 1.1e14 + jitter(5e12);
  const ib2 = 1.1e14 + jitter(5e12);
  const lumi = 8e33 + jitter(5e32);
  return {
    t: now,
    energy,
    speed: betaFromGeV(energy),
    ib1, ib2, lumi,
    species: "protons",
    _meta: { mock: true }
  };
}

// ---------- main pull ----------------------------------------------------------
async function pullOnce() {
  if (MOCK) return await readMock();

  const payloads = {};
  if (ENERGY_URL) payloads.energy = await getJSON(ENERGY_URL);
  if (IB1_URL)    payloads.ib1    = await getJSON(IB1_URL);
  if (IB2_URL)    payloads.ib2    = await getJSON(IB2_URL);
  if (LUMI_URL)   payloads.lumi   = await getJSON(LUMI_URL);

  const energyGeV = payloads.energy ? (
      num(pickByRegex(payloads.energy, /(^|_)energy($|_)|beam.?energy|total.?energy/i))
    ) : null;

  const IB1 = payloads.ib1 ? (
      num(pickByRegex(payloads.ib1, /(ib1|beam.?1.*(intensity|current))/i))
    ) : null;

  const IB2 = payloads.ib2 ? (
      num(pickByRegex(payloads.ib2, /(ib2|beam.?2.*(intensity|current))/i))
    ) : null;

  const lumi = payloads.lumi ? (
      num(pickByRegex(payloads.lumi, /lumi|instant.*lumi|luminosit/i))
    ) : null;

  const now = Math.floor(Date.now() / 1000);
  const speed = energyGeV != null ? betaFromGeV(energyGeV) : null;

  let species = FORCE_SPECIES || guessSpeciesFromPayload(payloads.energy, payloads.ib1, payloads.ib2, payloads.lumi) || "unknown";

  return {
    t: now,
    energy: energyGeV ?? null,
    speed,
    ib1: IB1 ?? null,
    ib2: IB2 ?? null,
    lumi: lumi ?? null,
    species,
    _meta: {
      fetched_at: new Date().toISOString(),
      sources: {
        energy: !!payloads.energy,
        ib1: !!payloads.ib1,
        ib2: !!payloads.ib2,
        lumi: !!payloads.lumi
      }
    }
  };
}

// ---------- history handling ---------------------------------------------------
function readLastLine(p) {
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p, "utf8").trimEnd();
  const idx = buf.lastIndexOf("\n");
  const line = idx >= 0 ? buf.slice(idx + 1) : buf;
  try { return JSON.parse(line); } catch { return null; }
}

function loadAllLines(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8")
    .split(/\r?\n/).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function saveLatest(obj) {
  fs.writeFileSync(LATEST, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function appendHistory(obj) {
  fs.appendFileSync(HISTORY, JSON.stringify(obj) + "\n", "utf8");
}

function pruneHistory(maxAgeSec = 48 * 3600) {
  const now = Math.floor(Date.now() / 1000);
  const all = loadAllLines(HISTORY);
  const kept = all.filter(r => typeof r?.t === "number" && (now - r.t) <= maxAgeSec);
  fs.writeFileSync(HISTORY, kept.map(r => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""), "utf8");
}

async function main() {
  ensureDir(DATA_DIR);

  const sample = await pullOnce();

  // Write latest.json (für die Website)
  saveLatest(sample);

  // Append to history (dupe-avoid + retention)
  const last = readLastLine(HISTORY);
  const isDup =
    last &&
    Math.abs((last.t ?? 0) - sample.t) <= 60 &&
    last.energy === sample.energy &&
    last.ib1 === sample.ib1 &&
    last.ib2 === sample.ib2 &&
    last.lumi === sample.lumi;

  if (!isDup) appendHistory(sample);
  pruneHistory(48 * 3600); // 48h behalten (Frontend zeigt eh ein Fenster)

  console.log("ok:", {
    latest: path.relative(ROOT, LATEST),
    history: path.relative(ROOT, HISTORY),
    t: sample.t,
    species: sample.species
  });
}

main().catch(err => {
  console.error("[telemetry] ERROR:", err);
  process.exit(1);
});
