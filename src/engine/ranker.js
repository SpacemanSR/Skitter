'use strict';
/* Learned ranker: logistic regression over a handful of interpretable features.
   Starts from hand-set weights; every accepted / rejected fetch nudges it toward your habits.
   Training pulls weights toward the defaults (L2 prior), so a few odd days can't wreck it. */

const FEATURES = ['bias', 'lex', 'coverage', 'nameHit', 'sem', 'lexSem', 'recency', 'openedRecency', 'coopen', 'sameFolder', 'rejects', 'accepts'];
const RANKER_VERSION = 2; // bump when feature meanings change; saved weights from older versions are discarded
const DEFAULT_W = { bias: -3.2, lex: 1.4, coverage: 2.4, nameHit: 1.6, sem: 2.8, lexSem: 0.6, recency: 0.4, openedRecency: 0.5, coopen: 2.8, sameFolder: 0.4, rejects: -2.2, accepts: 0.6 };

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
function vec(f) { return FEATURES.map((k) => (k === 'bias' ? 1 : (f[k] || 0))); }

class Ranker {
  constructor(saved) {
    const same = saved && saved.version === RANKER_VERSION;
    this.outdated = !!saved && !same;
    this.w = Object.assign({}, DEFAULT_W, (same && saved.w) || {});
    this.trainedOn = (saved && saved.trainedOn) || 0;
    this.autoThreshold = (saved && saved.autoThreshold) || 0.5;
    this.stats = (saved && saved.stats) || null;
  }
  prob(f) { let z = 0; for (const k of FEATURES) z += this.w[k] * (k === 'bias' ? 1 : (f[k] || 0)); return sigmoid(z); }
  explain(f) {
    // the feature that pushed hardest toward "yes" (used for the card's one-line reason)
    let best = null;
    for (const k of FEATURES) { if (k === 'bias') continue; const c = this.w[k] * (f[k] || 0); if (c > 0 && (!best || c > best.c)) best = { k, c }; }
    return best ? best.k : null;
  }
  /* examples: [{features, label (0|1), weight}] */
  train(examples, opts) {
    opts = opts || {};
    const minN = opts.minN || 15;
    if (examples.length < minN) { this.trainedOn = examples.length; return false; }
    const lambda = opts.lambda || 8.0, lr = opts.lr || 0.15, iters = opts.iters || 500;
    const w0 = FEATURES.map((k) => DEFAULT_W[k]);
    const w = FEATURES.map((k) => this.w[k]);
    const X = examples.map((e) => vec(e.features)), Y = examples.map((e) => e.label), Wt = examples.map((e) => e.weight == null ? 1 : e.weight);
    const sumW = Wt.reduce((a, b) => a + b, 0);
    for (let it = 0; it < iters; it++) {
      const g = new Array(w.length).fill(0);
      for (let i = 0; i < X.length; i++) {
        let z = 0; for (let j = 0; j < w.length; j++) z += w[j] * X[i][j];
        const err = (sigmoid(z) - Y[i]) * Wt[i];
        for (let j = 0; j < w.length; j++) g[j] += err * X[i][j];
      }
      for (let j = 0; j < w.length; j++) w[j] -= lr * (g[j] / sumW + (lambda / sumW) * (w[j] - w0[j]));
    }
    FEATURES.forEach((k, j) => { this.w[k] = +w[j].toFixed(4); });
    this.trainedOn = examples.length;
    return true;
  }
  /* Pick the lowest probability cutoff whose historical precision for unassigned trips meets the target. */
  calibrate(autoRecords, target) {
    target = target || 0.6;
    const recs = autoRecords.map((r) => ({ p: this.prob(r.features), y: r.label })).sort((a, b) => b.p - a.p);
    if (recs.length < 12) { this.stats = { autoN: recs.length, note: 'not enough unassigned trips yet' }; return this.autoThreshold; }
    let hits = 0, chosen = null;
    for (let i = 0; i < recs.length; i++) {
      hits += recs[i].y;
      const n = i + 1;
      if (n >= 8 && hits / n >= target) chosen = recs[i].p;
    }
    // no cutoff meets the target: be stricter than anything seen so far
    this.autoThreshold = chosen != null ? Math.max(0.2, Math.min(0.9, chosen)) : Math.min(0.92, (recs[0].p || 0.5) + 0.02);
    const above = recs.filter((r) => r.p >= this.autoThreshold);
    this.stats = { autoN: recs.length, threshold: +this.autoThreshold.toFixed(3), expectedPrecision: above.length ? +(above.reduce((a, r) => a + r.y, 0) / above.length).toFixed(3) : null, coverage: +(above.length / recs.length).toFixed(3) };
    return this.autoThreshold;
  }
  toJSON() { return { version: RANKER_VERSION, w: this.w, trainedOn: this.trainedOn, autoThreshold: this.autoThreshold, stats: this.stats }; }
}

/* outcome → label/weight for training */
function labelFor(outcome) {
  if (outcome === 'accept' || outcome === 'reveal') return { label: 1, weight: 1 };
  if (outcome === 'missed') return { label: 1, weight: 1.5 }; // you showed him the file he should have brought
  if (outcome === 'retry' || outcome === 'dismiss') return { label: 0, weight: 1 };
  if (outcome === 'ignore') return { label: 0, weight: 0.5 };
  return null;
}

module.exports = { Ranker, FEATURES, DEFAULT_W, labelFor };
