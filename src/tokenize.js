/* Tokenizer shared by the indexer, the query builder and the web demo (UMD). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Tokenize = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const STOP = new Set(('a an the and or but if then else of to in on at by for with from as is are was were be been being this that these those it its i me my we our you your he she they them his her their what which who whom whose when where why how all any both each few more most other some such no nor not only own same so than too very can will just do does did doing have has had having into over under again further once here there about above below up down out off also may might must shall should would could get got let lets im ive dont cant wont'
    + ' www http https com net org html htm doc docx pdf pptx xlsx txt md rtf file files new untitled copy page pages ok yes').split(/\s+/));

  function stem(w) {
    if (w.length <= 3) return w;
    if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
    if (w.endsWith('sses')) return w.slice(0, -2);
    if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
    if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
    if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && w.length > 3) return w.slice(0, -1);
    return w;
  }

  /* Split text into stemmed tokens. Handles camelCase, snake_case, kebab-case and unicode letters. */
  function tokenize(text) {
    if (!text) return [];
    const s = String(text)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[’']/g, '');
    const parts = s.split(/[^\p{L}\p{N}]+/u);
    const out = [];
    for (let w of parts) {
      if (!w || w.length < 2) continue;
      if (STOP.has(w)) continue;
      if (/^\d+$/.test(w) && (w.length < 2 || w.length > 6)) continue;
      w = stem(w);
      if (w.length < 2 || STOP.has(w)) continue;
      out.push(w);
    }
    return out;
  }

  function termFreq(tokens) { const tf = Object.create(null); for (const t of tokens) tf[t] = (tf[t] || 0) + 1; return tf; }

  return { tokenize, termFreq, stem, STOP };
});
