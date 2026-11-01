'use strict';
/* In-memory int8 vector store with brute-force cosine search. 40k chunks x 384 dims = 15 MB, ~20 ms per query. */
const DIM = 384;

class VectorStore {
  constructor() { this.cap = 0; this.n = 0; this.vecs = new Int8Array(0); this.chunkIds = new Int32Array(0); this.docIds = new Int32Array(0); this.dead = 0; }
  _grow(min) {
    if (this.cap >= min) return;
    let cap = Math.max(1024, this.cap * 2); while (cap < min) cap *= 2;
    const v = new Int8Array(cap * DIM); v.set(this.vecs.subarray(0, this.n * DIM)); this.vecs = v;
    const c = new Int32Array(cap); c.set(this.chunkIds.subarray(0, this.n)); this.chunkIds = c;
    const d = new Int32Array(cap); d.set(this.docIds.subarray(0, this.n)); this.docIds = d;
    this.cap = cap;
  }
  add(chunkId, docId, q /* Int8Array(DIM) */) {
    this._grow(this.n + 1);
    this.vecs.set(q, this.n * DIM); this.chunkIds[this.n] = chunkId; this.docIds[this.n] = docId; this.n++;
  }
  removeDoc(docId) { for (let i = 0; i < this.n; i++) if (this.docIds[i] === docId) { this.docIds[i] = -1; this.dead++; } if (this.dead > this.n / 4 && this.dead > 2000) this.compact(); }
  compact() {
    let w = 0;
    for (let r = 0; r < this.n; r++) {
      if (this.docIds[r] === -1) continue;
      if (w !== r) { this.vecs.copyWithin(w * DIM, r * DIM, (r + 1) * DIM); this.chunkIds[w] = this.chunkIds[r]; this.docIds[w] = this.docIds[r]; }
      w++;
    }
    this.n = w; this.dead = 0;
  }
  count() { return this.n - this.dead; }
  /* query: Float32Array unit vector → best similarity per doc, top `k` docs: [{docId, chunkId, sim}] */
  searchDocs(query, k, excludeDocIds) {
    const best = new Map();
    const v = this.vecs, n = this.n;
    for (let i = 0; i < n; i++) {
      const d = this.docIds[i]; if (d < 0) continue;
      let s = 0; const off = i * DIM;
      for (let j = 0; j < DIM; j++) s += query[j] * v[off + j];
      s /= 127;
      const cur = best.get(d);
      if (!cur || s > cur.sim) best.set(d, { docId: d, chunkId: this.chunkIds[i], sim: s });
    }
    const out = [];
    for (const b of best.values()) if (!excludeDocIds || !excludeDocIds.has(b.docId)) out.push(b);
    out.sort((a, b) => b.sim - a.sim);
    return out.slice(0, k);
  }
  /* best chunk of one doc */
  bestChunk(query, docId) {
    let best = null; const v = this.vecs;
    for (let i = 0; i < this.n; i++) {
      if (this.docIds[i] !== docId) continue;
      let s = 0; const off = i * DIM; for (let j = 0; j < DIM; j++) s += query[j] * v[off + j]; s /= 127;
      if (!best || s > best.sim) best = { chunkId: this.chunkIds[i], sim: s };
    }
    return best;
  }
}

module.exports = { VectorStore, DIM };
