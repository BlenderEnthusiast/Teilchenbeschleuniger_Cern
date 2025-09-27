// fetch-lhc.mjs — every 10 min, keep last 50 days (max ~7,200 points)

import {
  writeFileSync, appendFileSync, existsSync, mkdirSync,
  readFileSync, statSync, openSync, readSync, closeSync
} from 'node:fs';

const SRC          = 'https://lhcstatus2.ovh/vistars.json';
const DIR          = 'data';
const FILE_LATEST  = `${DIR}/latest.json`;
const FILE_HISTORY = `${DIR}/lhc_history.jsonl`;

// retention & sampling
const INTERVAL_SEC = 600;               // 10 minutes
const KEEP_DAYS    = 50;                // keep last 50 days
const MAX_POINTS   = KEEP_DAYS * 24 * (60 / 10); // 50 * 24 * 6 = 7200
const CUTOFF_SEC   = KEEP_DAYS * 24 * 3600;

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
if (!existsSync(FILE_HISTORY)) writeFileSync(FILE_HISTORY, '');

// ===== utils =====
const num = v => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

const pick = (obj, rx) => {
  const q = [obj];
  while (q.length) {
    const o = q.shift();
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if (rx.test(k)) {
          if (typeof v === 'number') return v;
          const n = num(v?.value ?? v);
          if (n != null) return n;
        }
        if (v && typeof v === 'object') q.push(v);
      }
    }
  }
  return null;
};

const betaFromGeV = (E) => {
  const m0 = 0.9382720813; // GeV
  const gamma = (E && E > 0) ? (E / m0) : 1;
  if (gamma <= 1) return 0;
  const b2 = 1 - 1/(gamma*gamma);
  return Math.sqrt(Math.max(0, Math.min(1, b2)));
};

// read last timestamp quickly
function getLastTimestamp(path) {
  try {
    const st = statSync(path);
    if (st.size === 0) return null;
    const fd = openSync(path, 'r');
    const bytes = Math.min(4096, st.size);
    const buf = Buffer.alloc(bytes);
    readSync(fd, buf, 0, bytes, st.size - bytes);
    closeSync(fd);
    const tail = buf.toString('utf8');
    const lines = tail.trim().split(/\r?\n/).filter(Boolean);
    const lastLine = lines[lines.length - 1];
    const obj = JSON.parse(lastLine);
    return typeof obj.t === 'number' ? obj.t : null;
  } catch {
    return null;
  }
}

// ===== fetch & extract =====
const resp = await fetch(SRC, { headers: { 'user-agent': 'gh-actions lhc fetcher' }});
if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
const j = await resp.json();

const energy = num(pick(j, /(^|_)energy($|_)|beam.?energy/i));
const ib1    = num(pick(j, /(ib1|beam.?1.*(intensity|current))/i));
const ib2    = num(pick(j, /(ib2|beam.?2.*(intensity|current))/i));
const lumi   = num(pick(j, /lumi|luminosit/i));

// bucket to exact 10-minute timestamp (dedupe protection)
const nowSec = Math.floor(Date.now() / 1000);
const tBucket = Math.floor(nowSec / INTERVAL_SEC) * INTERVAL_SEC;

const speed  = energy != null ? betaFromGeV(energy) : null;
const rec    = { t: tBucket, energy, speed, ib1, ib2, lumi };

// always refresh latest.json
writeFileSync(FILE_LATEST, JSON.stringify(rec, null, 2) + '\n');

// append if this bucket not already present
const lastT = getLastTimestamp(FILE_HISTORY);
if (lastT == null || tBucket > lastT) {
  appendFileSync(FILE_HISTORY, JSON.stringify(rec) + '\n');
  console.log(`Appended bucket t=${tBucket}`);
} else {
  console.log(`Skip append (duplicate bucket). lastT=${lastT}, t=${tBucket}`);
}

// ===== trim history to last 50 days / 7,200 points =====
try {
  const text = readFileSync(FILE_HISTORY, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);

  const objs = lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(o => o && typeof o.t === 'number');

  const cutoffT = nowSec - CUTOFF_SEC;
  let kept = objs.filter(o => o.t >= cutoffT);

  // cap to MAX_POINTS (keep newest N)
  if (kept.length > MAX_POINTS) {
    kept = kept.slice(kept.length - MAX_POINTS);
  }

  if (kept.length !== objs.length) {
    const out = kept.map(o => JSON.stringify(o)).join('\n') + '\n';
    writeFileSync(FILE_HISTORY, out);
    console.log(`Trimmed history: ${objs.length} → ${kept.length}`);
  } else {
    console.log(`No trim needed: ${objs.length} points`);
  }
} catch (e) {
  console.warn('Trim step skipped:', e.message);
}
