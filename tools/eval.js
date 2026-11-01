'use strict';
/* Offline evaluation. Run before shipping any ranking change.
     node tools/eval.js --db "<path to gofer.db>"                 replay your own history (every fetch you kept)
     node tools/eval.js --roots <dir> [--cases cases.json]        index a folder fresh and run hand-written cases
   Reports top-1 / top-3 hit rate and MRR, and for unassigned trips the precision at the current bar.
   cases.json: [{ "task": "...", "expect": "file name" } | { "mode": "auto", "title": "...", "currentPath": "...", "focusedText": "...", "expect": "..." }] */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Engine } = require('../src/engine/engine');
const { labelFor } = require('../src/engine/ranker');

const args = {}; for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const modelDir = args.model || path.join(os.homedir(), process.platform === 'win32' ? 'AppData/Roaming/Gofer/models/all-MiniLM-L6-v2' : '.config/Gofer/models/all-MiniLM-L6-v2');

function score(results) {
  const n = results.length; if (!n) return { n: 0 };
  const top1 = results.filter((r) => r.rank === 1).length, top3 = results.filter((r) => r.rank && r.rank <= 3).length;
  const mrr = results.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0) / n;
  return { n, top1: +(top1 / n).toFixed(3), top3: +(top3 / n).toFixed(3), mrr: +mrr.toFixed(3) };
}
const rankOf = (res, expect) => {
  const list = (res.top || []).map((t) => t.path.toLowerCase());
  const want = expect.toLowerCase();
  const i = list.findIndex((p) => p === want || path.basename(p) === want);
  return i >= 0 ? i + 1 : null;
};

(async () => {
  let engine, cases = [];
  if (args.db) {
    const copy = path.join(os.tmpdir(), 'gofer-eval-' + Date.now() + '.db');
    fs.copyFileSync(args.db, copy); for (const s of ['-wal', '-shm']) try { fs.copyFileSync(args.db + s, copy + s); } catch (e) {}
    engine = new Engine({ dbFile: copy, modelDir, roots: [], log: () => {} });
    engine.init(); await engine.embedder.load(); engine.ready = true;
    const hist = engine.history(5000);
    for (const h of hist) { const l = labelFor(h.outcome); if (l && l.label) cases.push(Object.assign({}, h.ctx, { mode: h.mode, expect: h.path, exclude: h.ctx.exclude || [] })); }
    // unassigned-trip precision at the current bar, from what actually happened
    const auto = hist.filter((h) => h.mode === 'auto' && labelFor(h.outcome));
    const thr = engine.ranker.autoThreshold;
    const above = auto.filter((h) => engine.ranker.prob(h.features) >= thr);
    console.log('unassigned trips: ' + auto.length + ' logged; bar ' + thr.toFixed(3) + '; would still go on ' + above.length + '; kept ' + above.filter((h) => labelFor(h.outcome).label).length);
  } else {
    const roots = (args.roots || '').split(',').filter(Boolean);
    const dbFile = path.join(os.tmpdir(), 'gofer-eval-' + Date.now() + '.db');
    engine = new Engine({ dbFile, modelDir, roots, log: () => {} });
    engine.init(); await engine.scan(); await engine.embedder.load(); await engine.embedIdle();
  }
  if (args.cases) cases = cases.concat(JSON.parse(fs.readFileSync(args.cases, 'utf8')));
  if (!cases.length) { console.log('No cases. Use the app for a while (every kept fetch becomes a case) or pass --cases.'); return; }

  const results = [];
  for (const c of cases) {
    const res = await engine.search(Object.assign({ mode: c.mode || 'task' }, c, { mode: c.mode || 'task' }));
    const rank = rankOf(res, c.expect);
    results.push({ rank, mode: c.mode || 'task' });
    if (args.verbose || !rank || rank > 1) console.log((rank ? 'rank ' + rank : 'MISS  ') + '  ' + (c.task || c.title || '') + '  →  want ' + path.basename(c.expect) + (res.top && res.top[0] ? ', got ' + res.top[0].name : ''));
  }
  console.log('\nall      ', JSON.stringify(score(results)));
  console.log('assigned ', JSON.stringify(score(results.filter((r) => r.mode === 'task'))));
  console.log('auto     ', JSON.stringify(score(results.filter((r) => r.mode === 'auto'))));
  const min = args['min-top1'] != null ? Number(args['min-top1']) : null;
  const all = score(results);
  if (min != null && all.top1 < min) { console.error('top-1 ' + all.top1 + ' is below the required ' + min); process.exitCode = 1; }
  engine.close();
})().catch((e) => { console.error(e); process.exit(1); });
