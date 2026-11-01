/* BM25 ranking with filename/recency boosts, query building, and passage selection.
   UMD so the web demo can run the same scoring over a fake corpus.
   index shape: { docs: Map|Array of doc, df: Map, avgLen: number } where doc = { path, name, ext, dir, mtime, len, tf, ntf } */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./tokenize'));
  else root.Search = factory(root.Tokenize);
})(typeof self !== 'undefined' ? self : this, function (Tokenize) {
  'use strict';
  const K1 = 1.2, B = 0.75;

  /* parts: [{ text, weight }] → { terms: {stem: weight}, words: {stem: originalWord}, display } */
  function buildQuery(parts) {
    const terms = Object.create(null), words = Object.create(null); const display = [];
    for (const part of parts) {
      if (!part || !part.text) continue;
      const raw = String(part.text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^\p{L}\p{N}']+/u).filter(Boolean);
      for (const w of raw) {
        const toks = Tokenize.tokenize(w);
        for (const t of toks) {
          const wt = part.weight == null ? 1 : part.weight;
          terms[t] = Math.max(terms[t] || 0, wt);
          if (!words[t]) words[t] = w.replace(/^'+|'+$/g, '').toLowerCase();
        }
      }
      display.push(String(part.text).trim());
    }
    return { terms, words, display: display.join(' · ') };
  }

  function docsOf(index) { return index.docs instanceof Map ? index.docs.values() : index.docs; }
  function countDocs(index) { return index.docs instanceof Map ? index.docs.size : index.docs.length; }
  function idf(index, N, t) { const df = index.df.get ? (index.df.get(t) || 0) : (index.df[t] || 0); return Math.log(1 + (N - df + 0.5) / (df + 0.5)); }

  /* opts: { exclude:Set|Array, currentTitle, limit, now } */
  function rank(index, terms, opts) {
    opts = opts || {};
    const N = countDocs(index); if (!N) return [];
    const exclude = new Set((opts.exclude || []).map((p) => String(p).toLowerCase()));
    const title = (opts.currentTitle || '').toLowerCase();
    const now = opts.now || Date.now();
    const qterms = Object.keys(terms); if (!qterms.length) return [];
    const idfs = Object.create(null); let totalW = 0;
    for (const t of qterms) { idfs[t] = idf(index, N, t); totalW += terms[t] * idfs[t]; }
    const out = [];
    for (const d of docsOf(index)) {
      if (exclude.has(d.path.toLowerCase())) continue;
      const base = d.name.toLowerCase().replace(/\.[^.]+$/, '');
      if (title && base.length >= 5 && title.includes(base)) continue; // the document that's already open
      let score = 0, matchedW = 0; const matched = [];
      const norm = K1 * (1 - B + B * (d.len / index.avgLen));
      for (const t of qterms) {
        const tf = d.tf[t] || 0; const ntf = d.ntf ? (d.ntf[t] || 0) : 0;
        if (!tf && !ntf) continue;
        const w = terms[t] * idfs[t];
        if (tf) score += w * (tf * (K1 + 1)) / (tf + norm);
        if (ntf) score += w * 1.6; // filename / parent folder match
        matchedW += w; matched.push(t);
      }
      if (score <= 0) continue;
      const ageDays = Math.max(0, (now - (d.mtime || 0)) / 86400000);
      score *= 1 + 0.3 * Math.exp(-ageDays / 45);
      out.push({ doc: d, score, matched, coverage: totalW ? matchedW / totalW : 0 });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, opts.limit || 8);
  }

  /* Pick the ~len-char window of text with the most query-term hits. words: {stem: original}. */
  function bestPassage(text, terms, words, len) {
    len = len || 300;
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    const stems = Object.keys(terms); if (!stems.length) return clean.slice(0, len);
    const hits = []; const re = /[\p{L}\p{N}']+/gu; let m;
    while ((m = re.exec(clean))) {
      const tok = Tokenize.tokenize(m[0]); if (!tok.length) continue;
      const s = tok[0]; const orig = m[0].toLowerCase();
      for (const t of stems) { if (s === t || (words && words[t] && orig.startsWith(words[t].slice(0, Math.max(3, words[t].length - 1))))) { hits.push({ pos: m.index, term: t, w: terms[t] }); break; } }
      if (hits.length > 4000) break;
    }
    if (!hits.length) return clean.slice(0, len) + (clean.length > len ? '…' : '');
    let best = { start: 0, score: -1 };
    for (let i = 0; i < hits.length; i++) {
      const start = Math.max(0, hits[i].pos - Math.floor(len * 0.25)); const end = start + len;
      const seen = new Set(); let score = 0;
      for (let j = i; j < hits.length && hits[j].pos < end; j++) { if (!seen.has(hits[j].term)) { seen.add(hits[j].term); score += hits[j].w * 2; } else score += hits[j].w * 0.3; }
      if (score > best.score) best = { start, score };
    }
    let start = best.start, end = Math.min(clean.length, start + len);
    if (start > 0) { const sp = clean.indexOf(' ', start); if (sp > 0 && sp - start < 30) start = sp + 1; }
    if (end < clean.length) { const sp = clean.lastIndexOf(' ', end); if (sp > start + len * 0.6) end = sp; }
    return (start > 0 ? '…' : '') + clean.slice(start, end) + (end < clean.length ? '…' : '');
  }

  return { buildQuery, rank, bestPassage, idf };
});
