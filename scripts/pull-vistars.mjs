// scripts/pull-vistars.mjs
// Node 20+
// Liest eine öffentliche Vistars-JSON-Quelle (URL unten) und schreibt:
// - data/vistars-raw.json (Rohdaten, zum Debuggen)
// - data/latest.json       (normiert: {t, energy, speed, ib1, ib2, lumi, species, _debug})
// - data/lhc_history.jsonl (append; optional)

import fs from 'node:fs/promises';

const OUT_RAW     = 'data/vistars-raw.json';
const OUT_LATEST  = 'data/latest.json';
const OUT_HISTORY = 'data/lhc_history.jsonl';

// 1) Quelle: passe an, wenn du eine andere JSON-Struktur nutzt.
// Wenn du eine *eigene* Proxy-JSON hast, setze VISTARS_URL als Actions-Secret.
const VISTARS_URL = process.env.VISTARS_URL
  || 'https://op-webtools.web.cern.ch/vistar/api/lhc-status.json'; // <— ggf. anpassen

async function httpGetJson(url){
  const res = await fetch(url, {
    headers:{
      'User-Agent':'Mozilla/5.0 (GitHub Actions; +telemetry)',
      'Cache-Control':'no-cache',
      'Pragma':'no-cache',
      'Accept':'application/json,text/plain;q=0.9,*/*;q=0.8',
    }
  });
  const text = await res.text();
  let json = null, parseErr=null;
  try{ json = JSON.parse(text); }catch(e){ parseErr = String(e); }
  return { ok: res.ok, status: res.status, text, json, parseErr };
}

// Suche Zahl per Regex über *alle* Objektebene(n)
function num(x){ if (x==null) return null; const n = (typeof x==='number')?x:parseFloat(String(x).replace(',','.')); return Number.isFinite(n)?n:null; }
function pickByRegex(obj, rx){
  const q=[obj]; const paths=[];
  while(q.length){
    const o=q.shift();
    if(o && typeof o==='object'){
      for(const [k,v] of Object.entries(o)){
        const path = k;
        if(rx.test(k)){
          if(typeof v==='number') return { value:v, path };
          const n = num(v?.value ?? v);
          if(n!=null) return { value:n, path };
        }
        if(v && typeof v==='object') q.push(v);
      }
    }
  }
  return { value:null, path:null };
}
function betaFromGeV(E){
  const m0 = 0.9382720813; // GeV (Proton)
  const gamma = (E && E>0) ? (E/m0) : 1;
  if (gamma<=1) return 0;
  const b2 = 1 - 1/(gamma*gamma);
  return Math.sqrt(Math.max(0, Math.min(1, b2)));
}

async function main(){
  const t = Math.floor(Date.now()/1000);
  const start = Date.now();

  const { ok, status, json, text, parseErr } = await httpGetJson(VISTARS_URL);

  // Rohdump immer mitschreiben (hilft beim Debug)
  await fs.writeFile(OUT_RAW, ok ? JSON.stringify(json, null, 2) : text, 'utf8');

  let energy=null, ib1=null, ib2=null, lumi=null, species='unknown';
  let kE=null, kI1=null, kI2=null, kL=null;

  if(ok && json){
    const pE  = pickByRegex(json, /(^|_)(energy|beam.?energy|lhc.?energy)(_|$)/i);
    const pI1 = pickByRegex(json, /(ib1|beam.?1.*(intensity|current))/i);
    const pI2 = pickByRegex(json, /(ib2|beam.?2.*(intensity|current))/i);
    const pL  = pickByRegex(json, /(lumi|luminosit)/i);

    energy = pE.value;
    ib1    = pI1.value;
    ib2    = pI2.value;
    lumi   = pL.value;

    kE = pE.path; kI1 = pI1.path; kI2 = pI2.path; kL = pL.path;

    // Species-Heuristik
    const isIon = /ion|pb|lead/i.test(JSON.stringify(json));
    const isProt = /proton|pp\b/i.test(JSON.stringify(json));
    if(isIon && !isProt) species='ions';
    else if(isProt && !isIon) species='protons';
    else species = (energy && energy>200 && (ib1||ib2)) ? 'protons' : 'unknown';
  }

  const speed = energy!=null ? betaFromGeV(energy) : null;
  const elapsed = Date.now() - start;

  const latest = {
    t,
    energy: energy ?? null,
    speed:  speed  ?? null,
    ib1:    ib1    ?? null,
    ib2:    ib2    ?? null,
    lumi:   lumi   ?? null,
    species,
    _debug: {
      source: VISTARS_URL,
      status,
      ok,
      reason: (!ok ? 'HTTP Fehler oder kein JSON' : (energy==null && ib1==null && ib2==null && lumi==null ? 'keine passenden Felder gefunden' : 'ok')),
      keysFound: [kE,kI1,kI2,kL].filter(Boolean),
      fetched_at: new Date().toISOString(),
      parse_error: parseErr || null,
      elapsed_ms: elapsed
    }
  };

  await fs.writeFile(OUT_LATEST, JSON.stringify(latest, null, 2)+'\n', 'utf8');

  // Optional: History anhängen, aber nur wenn mindestens *irgendwas* da ist
  if(energy!=null || ib1!=null || ib2!=null || lumi!=null){
    const slim = { t, energy:latest.energy, speed:latest.speed, ib1:latest.ib1, ib2:latest.ib2, lumi:latest.lumi, species };
    await fs.appendFile(OUT_HISTORY, JSON.stringify(slim)+'\n', 'utf8')
      .catch(()=>{ /* file may not exist yet */ });
  }
}

main().catch(async e=>{
  const t = Math.floor(Date.now()/1000);
  const latest = {
    t, energy:null, speed:null, ib1:null, ib2:null, lumi:null, species:'unknown',
    _debug:{ ok:false, reason:String(e), fetched_at:new Date().toISOString(), source:VISTARS_URL }
  };
  await fs.writeFile(OUT_LATEST, JSON.stringify(latest, null, 2)+'\n', 'utf8');
  process.exitCode = 1;
});
