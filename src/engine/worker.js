'use strict';
/* Entry point of the background engine process (Electron utilityProcess).
   Protocol: parent sends {id, cmd, args}; we reply {id, ok, result|error}. Unsolicited: {event, data}. */
const { Engine } = require('./engine');

const port = process.parentPort;
let engine = null;
const send = (m) => { try { port.postMessage(m); } catch (e) {} };
const log = (...a) => send({ event: 'log', data: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') });

const handlers = {
  async init(a) {
    engine = new Engine(Object.assign({}, a, { log }));
    engine.on('progress', (p) => send({ event: 'progress', data: p }));
    const st = engine.init();
    engine.watch();
    engine.scan().catch((e) => log('scan failed', e.message));
    return st;
  },
  async search(a) { return engine.search(a); },
  async resolveFile(a) { return engine.resolveFile(a); },
  async opened(a) { (a.items || [a]).forEach((o) => engine.opened(o.path, o.ts, o.src)); return true; },
  async outcome(a) { return engine.outcome(a.id, a.outcome); },
  async stats() { return Object.assign(engine.stats(), { summary: engine.summary() }); },
  async rescan(a) { engine.scan({ full: !!(a && a.full) }); return true; },
  async setRoots(a) { engine.setRoots(a.roots); engine.scan(); return true; },
  async diagnose(a) { return engine.diagnose(a); },
  async preview(a) { return engine.preview(a); },
  async setSemantic(a) { engine.semantic = !!a.on; if (a.on) engine.embedder.load().then((ok) => ok && engine._embedLoop()); return true; },
  async history(a) { return engine.history(a && a.limit); },
  async shutdown() { engine && engine.close(); setTimeout(() => process.exit(0), 50); return true; }
};

port.on('message', async (e) => {
  const msg = e.data || {};
  const h = handlers[msg.cmd];
  if (!h) return send({ id: msg.id, ok: false, error: 'unknown command ' + msg.cmd });
  try { send({ id: msg.id, ok: true, result: await h(msg.args || {}) }); }
  catch (err) { log('command failed', msg.cmd, err.stack || err.message); send({ id: msg.id, ok: false, error: err.message }); }
});
process.on('uncaughtException', (e) => log('engine uncaught', e.stack || e.message));
process.on('unhandledRejection', (e) => log('engine unhandled', (e && e.stack) || String(e)));
