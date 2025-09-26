// Fetch LHC live JSON, append one line, trim to last hour
// File: data/lhc_history.jsonl  (JSON Lines: eine Zeile pro Sample)

import fs from "node:fs";
import path from "node:path";

// ---- Settings ------------------------------------------------------------
const SRC = "https://lhcstatus2.ovh/vistars.json"; // Live-JSON (Vistars-basiert)
const FILE = path.join("data", "lhc_history.jsonl");
const RETENTION_SEC = 3600; // 1 Stunde
const NOW = () => Math.floor(Date.now() / 1000);

// ---- Helpers -------------------------------------------------------------
const num = (x) => {
  if (x == null) return null;
  const n = typeof x === "number" ? x : parseFloat(String(x).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
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
function betaFromGeV(E_total_GeV) {
  const m0 = 0.9382720813; // Proton [GeV]
  const gamma = E_total_GeV && E_total_GeV > 0 ? E_total_GeV / m0 : 1;
  if (gamma <= 1) return 0;
  const b2 = 1 - 1 / (gamma * gamma);
  return Math.sqrt(Math.max(0, Math.min(1, b2)));
}

// ---- Read existing lines -------------------------------------------------
let lines = [];
if (fs.existsSync(FILE)) {
  const raw = fs.readFileSync(FILE, "utf8");
  lines = raw.split(/\r?\n/).filter(Boolean);
}

// ---- Fetch live sample ---------------------------------------------------
const r = await fetch(SRC, { cache: "no-store" });
if (!r.ok) throw new Error("Fetch failed: " + r.status);
const j = await r.json();

const energyGeV = num(pickByRegex(j, /(^|_)energy($|_)|beam.?energy/i));
const ib1       = num(pickByRegex(j, /(ib1|beam.?1.*(intensity|current))/i));
const ib2       = num(pickByRegex(j, /(ib2|beam.?2.*(intensity|current))/i));
const lumi      = num(pickByRegex(j, /lumi|luminosit/i)); // optional

const t = NOW();
const speed = energyGeV != null ? betaFromGeV(energyGeV) : null;

const entry = { t, energy: energyGeV, speed, ib1, ib2, lumi };
const line  = JSON.stringify(entry);

// ---- Append (avoid dup if last t equal) ---------------------------------
const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
if (!last || last.t !== t) {
  lines.push(line);
}

// ---- Trim to last hour + small overlap ----------------------------------
const cutoff = t - (RETENTION_SEC);
lines = lines.filter((L) => {
  try {
    const o = JSON.parse(L);
    return o && typeof o.t === "number" && o.t >= cutoff;
  } catch {
    return false;
  }
});

// ---- Ensure folder & write ----------------------------------------------
fs.mkdirSync(path.dirname(FILE), { recursive: true });
fs.writeFileSync(FILE, lines.join("\n") + "\n", "utf8");
console.log(`Saved ${lines.length} lines to ${FILE}`);
