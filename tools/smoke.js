'use strict';
/* Launch the packaged app in an isolated data folder, let it index the test fixtures, send Skitter on a
   meaning-only fetch, and check what came back. Saves screenshots for the run artifacts.
     node tools/smoke.js [path to Skitter.exe]     (default: release/win-unpacked/Skitter.exe)
     node tools/smoke.js --dev                   (run from source with the local Electron) */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const dev = process.argv.includes('--dev');
const exe = dev ? null : (process.argv[2] || path.join(ROOT, 'release', 'win-unpacked', 'Skitter.exe'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gofer-smoke-'));
const shots = path.join(ROOT, 'smoke-shots');
fs.mkdirSync(shots, { recursive: true });
const fixtures = path.join(ROOT, 'tests', 'fixtures');

const env = Object.assign({}, process.env, {
  GOFER_USERDATA: path.join(work, 'data'), GOFER_SMOKE: shots,
  GOFER_ROOTS: [path.join(fixtures, 'Documents'), path.join(fixtures, 'Desktop')].join(path.delimiter), NODE_OPTIONS: ''
});
if (dev && fs.existsSync(path.join(ROOT, 'model', 'model_quantized.onnx'))) env.GOFER_MODEL_DIR = path.join(ROOT, 'model');

const cmd = dev ? process.execPath : exe;
const cmdArgs = dev ? [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '--no-sandbox', ROOT] : [];
if (!dev && !fs.existsSync(exe)) { console.error('not found: ' + exe); process.exit(1); }
console.log('launching ' + (dev ? 'dev app' : exe));
const child = spawn(cmd, cmdArgs, { env, stdio: 'ignore' });
const timer = setTimeout(() => { console.error('timed out after 180 s'); child.kill(); }, 180000);

child.on('exit', (code) => {
  clearTimeout(timer);
  const logFile = path.join(work, 'data', 'gofer.log');
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  fs.writeFileSync(path.join(shots, 'gofer.log'), log);
  const lines = log.split('\n');
  const grab = (re) => lines.filter((l) => re.test(l)).map((l) => l.slice(25));
  console.log('\n--- what happened ---');
  grab(/engine init|scan done|embedder|context helper|\[ctx\]|fetch task|presenting after|\[smoke\] stats|failed|error/i).slice(0, 40).forEach((l) => console.log('  ' + l));
  const checks = [
    ['engine started and indexed the fixtures', /scan done: 1\d docs/.test(log)],
    ['meaning search loaded the bundled model', /embedder ready/.test(log)],
    ['meaning-only request found the budget', /fetch task .*→ market_budget\.xlsx/.test(log)],
    ['card was presented', /presenting after \d+ ms; mode present/.test(log)],
    ['the fetch was kept and logged for learning', /"kept":1/.test(log)],
    ['PDF text was read inside the app (not just its name)', (() => { try { const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(work, 'data', 'gofer.db'), { readOnly: true }); const r = db.prepare("SELECT MIN(content) c, COUNT(*) n FROM docs WHERE ext = '.pdf'").get(); db.close(); return r.n > 0 && r.c === 1; } catch (e) { return false; } })()]
  ];
  console.log('\n--- checks ---');
  let ok = true;
  for (const [name, pass] of checks) { console.log((pass ? '  PASS ' : '  FAIL ') + name); if (!pass) ok = false; }
  const helper = /context helper ready \(event-driven\)/.test(log) ? 'event-driven (window events + cursor text)' : /falling back to polling/.test(log) ? 'fallback (titles only)' : 'not observed';
  console.log('  INFO context helper: ' + helper + (process.platform === 'win32' ? '' : ' (Windows only)'));
  console.log('\nscreenshots + log: ' + shots);
  process.exit(ok && code === 0 ? 0 : 1);
});
