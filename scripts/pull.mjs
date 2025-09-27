import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = process.env.SRC_URL ?? "https://lhcstatus2.ovh/vistars.json";

function num(x){ if(x==null) return null; const n=(typeof x==="number")?x:parseFloat(String(x).replace(",",".")); return Number.isFinite(n)?n:null; }
function pickByRegex(obj, rx){
  const q=[obj];
  while(q.length){
    const o=q.shift();
    if(o && typeof o==="object"){
      for(const [k,v] of Object.entries(o)){
        if(rx.test(k)){
          if (typeof v === "number") return v;
          const n = num(v?.value ?? v);
          if (n!=null) return n;
        }
        if(v && typeof v==="object") q.push(v);
      }
    }
  }
  return null;
}
function betaFromGeV(E){
  const m0 = 0.9382720813;   // Protonenruhemasse in GeV
  const gamma = E>0 ? (E/m0) : 1;
  if (gamma<=1) return 0;
  const b2 = 1 - 1/(gamma*gamma);
  return Math.sqrt(Math.max(0, Math.min(1, b2)));
}

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, "..");
const dataDir = path.join(repoRoot, "data");
fs.mkdirSync(dataDir, { recursive: true });

const res = await fetch(SRC, { headers: { "user-agent": "gh-action" } });
if (!res.ok) throw new Error("HTTP "+res.status);
const json = await res.json();

// Roh-JSON für die Seite ablegen (Frontend extrahiert selbst robust)
fs.writeFileSync(path.join(dataDir, "latest.json"), JSON.stringify(json, null, 2) + "\n");

// Werte für History extrahieren
const energy = num(pickByRegex(json, /(^|_)energy($|_)|beam.?energy/i));
const ib1    = num(pickByRegex(json, /(ib1|beam.?1.*(intensity|current))/i));
const ib2    = num(pickByRegex(json, /(ib2|beam.?2.*(intensity|current))/i));
const lumi   = num(pickByRegex(json, /lumi|luminosit/i));
const t      = Math.floor(Date.now()/1000);
const speed  = energy!=null ? betaFromGeV(energy) : null;

const histPath = path.join(dataDir, "lhc_history.jsonl");

let hist = [];
if (fs.existsSync(histPath)) {
  hist = fs.readFileSync(histPath, "utf8").split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
}

// nur letzte 24h behalten
const cutoff = t - 24*3600;
hist = hist.filter(o => typeof o.t === "number" && o.t >= cutoff);

// Dubletten vermeiden (gleiche Minute & gleiche Werte)
const last = hist[hist.length-1];
const entry = { t, energy, speed, ib1, ib2, lumi };
const isDup = last && Math.abs(last.t - t) <= 60 &&
              last.energy === energy && last.ib1 === ib1 && last.ib2 === ib2 && last.lumi === lumi;

if (!isDup) hist.push(entry);

fs.writeFileSync(histPath, hist.map(o => JSON.stringify(o)).join("\n") + "\n");

console.log("Updated data/latest.json and data/lhc_history.jsonl with", hist.length, "points");
