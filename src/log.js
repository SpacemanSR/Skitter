'use strict';
const fs = require('fs');
const path = require('path');

/* Human-readable files in the data folder:
   gofer.log        debug lines (rotated at 5 MB)
   proposals.jsonl  every fetch, the context it came from, and what you did with it.
   The engine keeps its own copy (with features) in gofer.db for learning; this one is for you. */
class Log {
  constructor(dir) {
    this.dir = dir; fs.mkdirSync(dir, { recursive: true });
    this.debugFile = path.join(dir, 'gofer.log');
    this.proposalsFile = path.join(dir, 'proposals.jsonl');
    this.pending = new Map();
    try { if (fs.statSync(this.debugFile).size > 5e6) fs.renameSync(this.debugFile, this.debugFile + '.1'); } catch (e) {}
  }
  debug(...args) {
    const line = new Date().toISOString() + ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
    try { fs.appendFileSync(this.debugFile, line); } catch (e) {}
    if (process.env.GOFER_DEBUG) process.stdout.write(line);
  }
  proposal(p, snap) {
    this.pending.set(p.id, { id: p.id, ts: p.ts, mode: p.mode, path: p.path, prob: p.prob, reason: p.reason || null, matched: p.matched,
      context: { title: snap.cleanTitle, process: snap.process, focused: snap.focusedSrc || null }, outcome: null });
  }
  outcome(id, outcome) {
    const rec = this.pending.get(id); if (!rec) return;
    rec.outcome = outcome; rec.latencyMs = Date.now() - rec.ts; this.pending.delete(id);
    try { fs.appendFileSync(this.proposalsFile, JSON.stringify(rec) + '\n'); } catch (e) {}
  }
}
module.exports = { Log };
