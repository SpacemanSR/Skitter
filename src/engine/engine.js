'use strict';
/* Skitter's engine. Runs in a background process (see worker.js) so indexing never stalls the creature.
   - SQLite full-text index (no document cap), incremental scans, live folder watching
   - chunk-level local embeddings, filled in the background, newest files first
   - hybrid candidate generation: keywords ∪ meaning ∪ opened-together
   - learned ranker + calibrated threshold for unassigned trips */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const DB = require('./db');
const { VectorStore, DIM } = require('./vectors');
const { Ranker, labelFor } = require('./ranker');
const { Embedder, quantize } = require('../embedder');
const Tokenize = require('../tokenize');
const { tokenize, termFreq } = Tokenize;
const Search = require('../search');
const extract = require('../extract');

// folders that are caches or machine-generated, never things you'd go looking for
const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.cache', '.idea', '.vscode', 'appdata', '$recycle.bin',
  'system volume information', 'windowsapps', 'onedrivetemp', 'bin', 'obj', '.next', '.nuxt', 'site-packages', '.godot', '.import', 'library', '.gradle', 'deriveddatacache', 'intermediate', 'saved']);
// files never worth fetching (system, temporary, compiled)
const SKIP_EXT = new Set(['.exe', '.dll', '.sys', '.msi', '.cab', '.tmp', '.temp', '.bak', '.crdownload', '.part', '.partial', '.lock', '.pyc', '.class', '.o', '.obj', '.so', '.dylib', '.lib', '.pdb', '.ilk', '.idb', '.dmp', '.etl', '.cache', '.db-wal', '.db-shm', '.ds_store', '.ini', '.lnk', '.import', '.uid', '.meta']);
const SKIP_NAMES = new Set(['thumbs.db', 'desktop.ini', '.ds_store', 'ntuser.dat']);
const TEXT_LIMITS = { '.pdf': 80e6, '.docx': 150e6, '.pptx': 150e6, '.xlsx': 60e6, '.odt': 150e6, '.odp': 150e6, '.ods': 60e6, default: 20e6 };
// what people call a file type when they ask for it ("the deck", "that spreadsheet", "the thumbnail")
const TYPE_WORDS = {
  '.pptx': 'deck slides presentation powerpoint', '.ppt': 'deck slides presentation powerpoint', '.key': 'deck slides presentation keynote', '.odp': 'deck slides presentation',
  '.xlsx': 'spreadsheet sheet excel table', '.xls': 'spreadsheet sheet excel table', '.csv': 'spreadsheet sheet table data', '.ods': 'spreadsheet sheet table',
  '.docx': 'document word', '.doc': 'document word', '.odt': 'document', '.rtf': 'document', '.pdf': 'document',
  '.md': 'notes markdown', '.txt': 'notes text',
  '.png': 'image picture graphic', '.jpg': 'image picture photo', '.jpeg': 'image picture photo', '.webp': 'image picture', '.gif': 'image animation gif', '.svg': 'image graphic vector logo',
  '.psd': 'photoshop image artwork', '.ai': 'illustrator artwork vector logo', '.kra': 'krita painting artwork', '.procreate': 'procreate painting artwork', '.blend': 'blender model scene',
  '.mp4': 'video clip footage', '.mov': 'video clip footage', '.mkv': 'video recording footage', '.webm': 'video clip',
  '.mp3': 'audio song track', '.wav': 'audio sound track', '.flac': 'audio track', '.m4a': 'audio recording',
  '.prproj': 'premiere project edit', '.aep': 'after effects project', '.drp': 'resolve project edit', '.fdx': 'script screenplay', '.fountain': 'script screenplay',
  '.zip': 'archive zip', '.7z': 'archive', '.rar': 'archive'
};
const BODY_CHARS = 400000;
const typeStemCache = new Map();
function typeStems(ext) { if (!typeStemCache.has(ext)) typeStemCache.set(ext, new Set(tokenize(TYPE_WORDS[ext] || ''))); return typeStemCache.get(ext); }
/* name tokens minus the ones that only came from the file-type words */
function realNameStems(nameField, ext) { const t = typeStems(ext); const counts = new Map(); for (const w of String(nameField).split(' ')) counts.set(w, (counts.get(w) || 0) + 1); const out = new Set(); for (const [w, n] of counts) if (!t.has(w) || n > 1) out.add(w); return out; } // how much text per file goes into the keyword index
const MAX_DEPTH = 12;
const CHUNK_CHARS = 520;
const DAY = 86400000;

/* letters and digits only, lowercased: lets "nightmarket" match "NightMarket_v3" */
const normName = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');

/* 'full' (read the text), 'name' (findable by name only) or 'skip' */
function verdict(name, st, cloudCheck) {
  const lower = name.toLowerCase(); const ext = path.extname(lower);
  if (lower.startsWith('~$') || lower.startsWith('.') || SKIP_NAMES.has(lower) || SKIP_EXT.has(ext) || st.size === 0) return 'skip';
  if (!extract.isSupported(ext)) return 'name';
  if (st.size > (TEXT_LIMITS[ext] || TEXT_LIMITS.default)) return 'name';
  if (cloudCheck && st.size > 4096 && st.blocks === 0) return 'name'; // OneDrive "online-only": reading it would download it
  return 'full';
}

function isExcludedPath(p, roots) {
  const root = roots.find((r) => p.toLowerCase().startsWith(r.toLowerCase()));
  const rel = root ? p.slice(root.length) : p;
  return rel.split(/[\\/]/).some((seg) => seg && (seg.startsWith('.') || EXCLUDED_DIRS.has(seg.toLowerCase())));
}

/* Split text into ~CHUNK_CHARS pieces on paragraph / sentence boundaries. */
function chunkText(text, maxChunks) {
  const clean = String(text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const paras = clean.split(/\n\s*\n|\n(?=[#*\-•]|\d+[.)] )/);
  const out = []; let cur = '';
  const push = () => { const t = cur.replace(/\s+/g, ' ').trim(); if (t.length >= 40 || (t && !out.length)) out.push(t); cur = ''; };
  for (const p of paras) {
    if (out.length >= maxChunks) break;
    if ((cur + ' ' + p).length <= CHUNK_CHARS) { cur = cur ? cur + '\n' + p : p; continue; }
    if (cur) push();
    if (p.length <= CHUNK_CHARS) { cur = p; continue; }
    const sentences = p.split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      if (out.length >= maxChunks) break;
      if ((cur + ' ' + s).length > CHUNK_CHARS && cur) push();
      cur = cur ? cur + ' ' + s : s;
      while (cur.length > CHUNK_CHARS * 1.6) { const cut = cur.lastIndexOf(' ', CHUNK_CHARS) > 200 ? cur.lastIndexOf(' ', CHUNK_CHARS) : CHUNK_CHARS; const head = cur.slice(0, cut); cur = cur.slice(cut); const keep = cur; cur = head; push(); cur = keep.trim(); if (out.length >= maxChunks) break; }
    }
  }
  if (cur && out.length < maxChunks) push();
  return out.slice(0, maxChunks);
}

function niceName(name) { return name.replace(/\.[^.]+$/, '').replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim(); }
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ordinal = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');

class Engine extends EventEmitter {
  constructor(opts) {
    super();
    this.dbFile = opts.dbFile;
    this.roots = (opts.roots || []).filter(Boolean);
    this.log = opts.log || (() => {});
    this.maxChunksPerDoc = opts.maxChunksPerDoc || 24;
    this.maxEmbedChunks = opts.maxEmbedChunks || 60000;
    this.maxDocs = opts.maxDocs || 250000;
    this.semantic = opts.semantic !== false;
    this.autoTarget = opts.autoTarget || 0.6;
    this.embedder = new Embedder({ modelDir: opts.modelDir, log: (...a) => this.log('[embed]', ...a) });
    this.vectors = new VectorStore();
    this.scanning = false; this.ready = false; this.embedding = false;
    this._readyWaiters = []; this._watchers = []; this._queue = new Map(); this._queueTimer = null;
    this._textCache = new Map();
    this._examined = 0;
  }

  // ---------- lifecycle ----------
  init() {
    this.db = DB.open(this.dbFile);
    this.ranker = new Ranker(DB.getMeta(this.db, 'ranker', null));
    if (this.ranker.outdated) { this.log('ranker features changed; relearning from history'); this.retrain(); }
    // retention: text snippets kept with past fetches (for replay tests) are wiped after 90 days; the numeric features stay for learning
    try { this.db.prepare("UPDATE proposals SET ctx = json_set(ctx, '$.focusedText', '', '$.clip', '', '$.task', NULL, '$.title', '', '$.cleanTitle', '') WHERE ts < ? AND ctx IS NOT NULL").run(Date.now() - 90 * DAY); } catch (e) { this.log('retention sweep failed', e.message); }
    const t0 = Date.now(); let n = 0;
    for (const r of this.db.prepare('SELECT id, doc_id, vec FROM chunks WHERE vec IS NOT NULL').iterate()) {
      const q = new Int8Array(r.vec.buffer, r.vec.byteOffset, DIM); this.vectors.add(r.id, r.doc_id, q); n++;
    }
    // On Windows, an online-only OneDrive file has no space allocated on disk. Only trust that signal if this machine reports it at all.
    try { const st = fs.statSync(process.execPath); this.cloudCheck = process.platform === 'win32' && st.blocks > 0; } catch (e) { this.cloudCheck = false; }
    const docs = this.docCount();
    this.ready = docs > 0;
    this.log('engine init: ' + docs + ' docs, ' + n + ' vectors loaded in ' + (Date.now() - t0) + 'ms');
    if (this.semantic) this.embedder.load().then((ok) => { this._emitProgress(); if (ok) this._embedLoop(); });
    return this.stats();
  }
  close() { this._watchers.forEach((w) => { try { w.close(); } catch (e) {} }); this._watchers = []; try { this.db.close(); } catch (e) {} }
  setRoots(roots) {
    this.roots = roots.filter(Boolean);
    const inRoots = (p) => this.roots.some((r) => p.toLowerCase().startsWith(r.toLowerCase()));
    for (const r of this.db.prepare('SELECT id, path FROM docs').all()) if (!inRoots(r.path)) this.deleteDoc(r.id);
    this.watch();
  }
  whenReady() { return this.ready ? Promise.resolve() : new Promise((r) => this._readyWaiters.push(r)); }
  _markReady() { this.ready = true; const w = this._readyWaiters; this._readyWaiters = []; w.forEach((r) => r()); }
  docCount() { return this.db.prepare('SELECT COUNT(*) n FROM docs').get().n; }
  stats() {
    const c = this.db.prepare('SELECT COUNT(*) n, SUM(CASE WHEN vec IS NULL THEN 0 ELSE 1 END) e FROM chunks').get();
    return { count: this.docCount(), ready: this.ready, scanning: this.scanning, examined: this._examined, chunks: c.n || 0, embeddedChunks: c.e || 0,
      semantic: this.semantic ? (this.embedder.ready ? 'on' : (this.embedder.failed ? 'unavailable: ' + this.embedder.failed : 'loading')) : 'off',
      ranker: { trainedOn: this.ranker.trainedOn, autoThreshold: +this.ranker.autoThreshold.toFixed(3), stats: this.ranker.stats }, roots: this.roots };
  }
  _emitProgress(note) { this.emit('progress', Object.assign(this.stats(), { note: note || '' })); }

  // ---------- indexing ----------
  async scan(opts) {
    if (this.scanning) return;
    this.scanning = true; this._examined = 0;
    const full = !!(opts && opts.full);
    if (full) { DB.tx(this.db, () => { this.db.exec('DELETE FROM chunks; DELETE FROM fts; DELETE FROM docs;'); }); this.vectors = new VectorStore(); }
    const known = new Map();
    for (const r of this.db.prepare('SELECT id, path, mtime, size FROM docs').iterate()) known.set(r.path, r);
    const seen = new Set(); let added = 0, lastEmit = 0;
    this._emitProgress('scanning');
    try {
      for (const root of this.roots) {
        if (!fs.existsSync(root)) continue;
        const stack = [{ dir: root, depth: 0 }];
        while (stack.length) {
          const { dir, depth } = stack.pop();
          let entries; try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
          for (const ent of entries) {
            this._examined++;
            const name = ent.name, lower = name.toLowerCase(), full = path.join(dir, name);
            if (ent.isSymbolicLink()) continue;
            if (ent.isDirectory()) { if (!lower.startsWith('.') && !EXCLUDED_DIRS.has(lower) && depth < MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 }); continue; }
            if (!ent.isFile() || lower.startsWith('~$') || lower.startsWith('.')) continue;
            let st; try { st = await fs.promises.stat(full); } catch (e) { continue; }
            const v = verdict(name, st, this.cloudCheck); if (v === 'skip') continue;
            seen.add(full);
            const k = known.get(full);
            if (k && k.mtime === Math.round(st.mtimeMs) && k.size === st.size) continue;
            if (!k && known.size + added >= this.maxDocs) continue;
            if (await this.indexFile(full, st, v)) added++;
            if (added % 25 === 0) await new Promise((r) => setImmediate(r));
            if (Date.now() - lastEmit > 500) { lastEmit = Date.now(); this._emitProgress('scanning'); }
            if (added === 30 && !this.ready) this._markReady(); // usable early on first run
          }
        }
      }
      // forget files that vanished from the current roots
      for (const [p, r] of known) if (!seen.has(p) && this.roots.some((root) => p.toLowerCase().startsWith(root.toLowerCase()))) this.deleteDoc(r.id);
      this.log('scan done: ' + this.docCount() + ' docs, ' + added + ' new/changed, ' + this._examined + ' entries');
    } catch (e) { this.log('scan error', e.stack || e.message); }
    this.scanning = false; this._markReady(); this._emitProgress('done');
    if (this.embedder.ready) this._embedLoop();
  }

  async indexFile(full, st, mode) {
    mode = mode || verdict(path.basename(full), st, this.cloudCheck);
    if (mode === 'skip') return false;
    const ext = path.extname(full).toLowerCase(), name = path.basename(full);
    const text = mode === 'full' ? await extract.extractText(full, BODY_CHARS) : '';
    const base = name.slice(0, name.length - ext.length);
    const parent = path.basename(path.dirname(full));
    const nameTokens = tokenize(base + ' ' + parent + ' ' + ext.slice(1) + ' ' + (TYPE_WORDS[ext] || ''));
    const tokens = tokenize(text);
    if (!tokens.length && !nameTokens.length) return false;
    let chunks = chunkText(text, this.maxChunksPerDoc);
    // files we can't read (images, video, project files, online-only) are still findable by meaning through their name
    if (!chunks.length) chunks = [niceName(name) + (ext ? ' (' + ext.slice(1) + ' file' : ' (file') + ' in ' + parent + ')'];
    const old = this.db.prepare('SELECT id FROM docs WHERE path=?').get(full);
    DB.tx(this.db, () => {
      if (old) { this.db.prepare('DELETE FROM fts WHERE rowid=?').run(old.id); this.db.prepare('DELETE FROM chunks WHERE doc_id=?').run(old.id); this.db.prepare('DELETE FROM docs WHERE id=?').run(old.id); }
      const r = this.db.prepare('INSERT INTO docs (path, name, nname, ext, dir, content, mtime, size, len, embedded, indexed_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)')
        .run(full, name, normName(base), ext, path.dirname(full), tokens.length ? 1 : 0, Math.round(st.mtimeMs), st.size, tokens.length || 1, Date.now());
      const id = Number(r.lastInsertRowid);
      this.db.prepare('INSERT INTO fts (rowid, name, body) VALUES (?,?,?)').run(id, nameTokens.join(' '), tokens.join(' '));
      const ins = this.db.prepare('INSERT INTO chunks (doc_id, idx, text) VALUES (?,?,?)');
      chunks.forEach((c, i) => ins.run(id, i, c));
    });
    if (old) this.vectors.removeDoc(old.id);
    this._textCache.delete(full);
    return true;
  }

  deleteDoc(id) {
    DB.tx(this.db, () => { this.db.prepare('DELETE FROM fts WHERE rowid=?').run(id); this.db.prepare('DELETE FROM chunks WHERE doc_id=?').run(id); this.db.prepare('DELETE FROM docs WHERE id=?').run(id); });
    this.vectors.removeDoc(id);
  }

  // ---------- live folder watching ----------
  watch() {
    this._watchers.forEach((w) => { try { w.close(); } catch (e) {} }); this._watchers = [];
    for (const root of this.roots) {
      if (!fs.existsSync(root)) continue;
      try {
        const w = fs.watch(root, { recursive: true, persistent: true }, (ev, filename) => { if (filename) this._enqueue(path.join(root, filename.toString())); });
        w.on('error', (e) => this.log('watch error', root, e.message));
        this._watchers.push(w);
      } catch (e) { this.log('cannot watch', root, e.message); }
    }
  }
  _enqueue(p) {
    if (isExcludedPath(p, this.roots)) return;
    this._queue.set(p, Date.now());
    clearTimeout(this._queueTimer); this._queueTimer = setTimeout(() => this._drain(), 1500);
  }
  async _drain() {
    if (this.scanning) { this._queueTimer = setTimeout(() => this._drain(), 3000); return; }
    const items = [...this._queue.keys()]; this._queue.clear();
    let changed = 0;
    for (const p of items) {
      let st = null; try { st = await fs.promises.stat(p); } catch (e) {}
      if (!st) { // removed or renamed away: drop the file, or everything under a vanished folder
        const one = this.db.prepare('SELECT id FROM docs WHERE path=?').get(p);
        if (one) { this.deleteDoc(one.id); changed++; continue; }
        const prefix = p.endsWith(path.sep) ? p : p + path.sep;
        for (const r of this.db.prepare('SELECT id FROM docs WHERE substr(path, 1, ?) = ?').all(prefix.length, prefix)) { this.deleteDoc(r.id); changed++; }
        continue;
      }
      if (st.isDirectory()) { await this._scanDir(p); changed++; continue; }
      if (!st.isFile()) continue;
      const v = verdict(path.basename(p), st, this.cloudCheck); if (v === 'skip') continue;
      const k = this.db.prepare('SELECT mtime, size FROM docs WHERE path=?').get(p);
      if (k && k.mtime === Math.round(st.mtimeMs) && k.size === st.size) continue;
      if (await this.indexFile(p, st, v)) changed++;
    }
    if (changed) { this.log('watch: ' + changed + ' change(s) applied'); this._emitProgress('updated'); if (this.embedder.ready) this._embedLoop(); }
  }
  async _scanDir(dir) {
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop(); let entries; try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch (e) { continue; }
      for (const ent of entries) { const f = path.join(d, ent.name); if (isExcludedPath(f, this.roots)) continue; if (ent.isDirectory()) stack.push(f); else if (ent.isFile()) this._queue.set(f, Date.now()); }
    }
    if (this._queue.size) { clearTimeout(this._queueTimer); this._queueTimer = setTimeout(() => this._drain(), 200); }
  }

  // ---------- background embedding ----------
  /* resolves when no un-embedded chunks remain (or embedding is unavailable) */
  async embedIdle() { for (;;) { if (!this.embedder.ready || !this.semantic) return; if (!this.embedding) { const n = this.db.prepare('SELECT COUNT(*) n FROM chunks WHERE vec IS NULL').get().n; if (!n || this.vectors.count() >= this.maxEmbedChunks) return; this._embedLoop(); } await new Promise((r) => setTimeout(r, 100)); } }

  async _embedLoop() {
    if (this.embedding || !this.embedder.ready || !this.semantic) return;
    this.embedding = true;
    const pick = this.db.prepare(`SELECT c.id, c.doc_id, c.text, d.name FROM chunks c JOIN docs d ON d.id = c.doc_id
      WHERE c.vec IS NULL ORDER BY d.mtime DESC, c.idx LIMIT 32`);
    const upd = this.db.prepare('UPDATE chunks SET vec=? WHERE id=?');
    const done = this.db.prepare('UPDATE docs SET embedded=1 WHERE id=? AND NOT EXISTS (SELECT 1 FROM chunks WHERE doc_id=? AND vec IS NULL)');
    let total = 0, lastEmit = 0;
    try {
      while (this.vectors.count() < this.maxEmbedChunks) {
        const rows = pick.all(); if (!rows.length) break;
        const vecs = await this.embedder.embed(rows.map((r) => niceName(r.name) + ': ' + r.text));
        const docIds = new Set();
        DB.tx(this.db, () => {
          rows.forEach((r, i) => {
            const still = this.db.prepare('SELECT 1 FROM chunks WHERE id=?').get(r.id); if (!still) return; // file changed while we embedded
            const q = quantize(vecs[i]); upd.run(Buffer.from(q.buffer), r.id); this.vectors.add(r.id, r.doc_id, q); docIds.add(r.doc_id);
          });
          for (const d of docIds) done.run(d, d);
        });
        total += rows.length;
        if (Date.now() - lastEmit > 2000) { lastEmit = Date.now(); this._emitProgress('embedding'); }
        await new Promise((r) => setTimeout(r, 25)); // let searches in
      }
    } catch (e) { this.log('embed loop error', e.stack || e.message); }
    this.embedding = false;
    if (total) { this.log('embedded ' + total + ' chunks; ' + this.vectors.count() + ' vectors total'); this._emitProgress('embedded'); }
  }

  // ---------- context helpers ----------
  async readText(p) {
    let st; try { st = fs.statSync(p); } catch (e) { return ''; }
    const key = p + '|' + st.mtimeMs;
    const hit = this._textCache.get(p);
    if (hit && hit.key === key) return hit.text;
    const text = await extract.extractText(p, 200000);
    this._textCache.set(p, { key, text });
    if (this._textCache.size > 30) this._textCache.delete(this._textCache.keys().next().value);
    return text;
  }
  _df(terms) {
    const out = new Map(); if (!terms.length) return out;
    const stmt = this.db.prepare(`SELECT term, doc FROM fts_v WHERE term IN (${terms.map(() => '?').join(',')})`);
    for (const r of stmt.all(...terms)) out.set(r.term, r.doc);
    return out;
  }
  /* The k most distinctive indexed terms of a text (tf-idf against your own files). */
  distinctive(text, k) {
    const tf = termFreq(tokenize(text)); const terms = Object.keys(tf).sort((a, b) => tf[b] - tf[a]).slice(0, 300);
    const N = Math.max(1, this.docCount()); const df = this._df(terms);
    return terms.filter((t) => df.get(t) && df.get(t) / N < 0.3 && t.length > 2)
      .map((t) => ({ t, s: (1 + Math.log(tf[t])) * Math.log(1 + N / df.get(t)) }))
      .sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.t);
  }

  /* Which indexed / recent file is the active window showing? */
  resolveFile({ title, recent }) {
    if (!title) return null;
    const segs = String(title).replace(/^[●•*]\s*/, '').replace(/\s*\[(Compatibility Mode|Read-Only|Protected View)\]|\s*\((Read-Only|Protected View|Unsaved)\)/gi, '')
      .split(/\s+[-–—|]\s+/).map((s) => s.trim()).filter(Boolean);
    const rec = (recent || []).filter((r) => r && r.path);
    const byBase = (b) => { const lb = b.toLowerCase(); const r = rec.find((x) => path.basename(x.path).toLowerCase() === lb); if (r) return r.path; const d = this.db.prepare('SELECT path FROM docs WHERE name = ? COLLATE NOCASE ORDER BY mtime DESC LIMIT 1').get(b); return d ? d.path : null; };
    const byStem = (s) => { const ls = s.toLowerCase(); const r = rec.find((x) => { const b = path.basename(x.path).toLowerCase(); return b.startsWith(ls + '.') && b.length - ls.length <= 6; }); if (r) return r.path;
      const d = this.db.prepare('SELECT path FROM docs WHERE lower(substr(name, 1, ?)) = ? AND substr(name, ? + 1, 1) = \'.\' AND length(name) - ? <= 6 ORDER BY mtime DESC LIMIT 1').get(ls.length, ls, ls.length, ls.length); return d ? d.path : null; };
    for (const s of segs) if (/\.[a-z0-9]{1,5}$/i.test(s) && s.length < 260) { const p = byBase(s); if (p) return p; }
    for (const s of segs.slice(0, 2)) if (s.length >= 3 && s.length < 200) { const p = byStem(s); if (p) return p; }
    return null;
  }

  // ---------- opened-together history ----------
  opened(p, ts, src) {
    if (!p) return;
    ts = ts || Date.now();
    const last = this.db.prepare('SELECT MAX(ts) t FROM opens WHERE path=?').get(p);
    if (last && last.t && Math.abs(ts - last.t) < 5 * 60000) return; // de-dupe bursts
    this.db.prepare('INSERT INTO opens (path, ts, src) VALUES (?,?,?)').run(p, Math.round(ts), src || '');
  }
  coopen(p, limit) {
    if (!p) return [];
    return this.db.prepare(`SELECT o2.path AS path, COUNT(*) AS c FROM opens o1 JOIN opens o2
      ON o2.ts BETWEEN o1.ts - 1200000 AND o1.ts + 1200000 AND o2.path <> o1.path
      WHERE o1.path = ? AND o1.ts > ? GROUP BY o2.path ORDER BY c DESC LIMIT ?`).all(p, Date.now() - 120 * DAY, limit || 20);
  }

  // ---------- search ----------
  /* req: { mode: 'task'|'auto'|'live', task, title, cleanTitle, focusedText, clip, currentPath, exclude[] } */
  async search(req) {
    await this.whenReady();
    const t0 = Date.now();
    // live: a live session. Reads your context like 'auto', but always returns its best guess (with the bar),
    // so the host can choose between a full trip, a quiet spot on the shelf, or nothing.
    const mode = req.mode === 'auto' || req.mode === 'live' ? req.mode : 'task';
    const now = Date.now();
    const currentText = req.currentPath ? (await this.readText(req.currentPath)) : '';
    const focused = String(req.focusedText || '').slice(-2500);
    const focusedTerms = focused ? this.distinctive(focused, 10).join(' ') : '';
    const docTerms = currentText ? this.distinctive(currentText, 12).join(' ') : '';
    const parts = mode === 'task'
      ? [{ text: req.task, weight: 1.6 }, { text: req.cleanTitle, weight: 0.3 }, { text: focusedTerms, weight: 0.3 }, { text: docTerms, weight: 0.2 }]
      : [{ text: req.cleanTitle, weight: 1.0 }, { text: focusedTerms, weight: 1.4 }, { text: docTerms, weight: 1.1 }, { text: req.clip, weight: 0.8 }];
    const q = Search.buildQuery(parts);
    const semText = mode === 'task' ? String(req.task || '')
      : (focused.trim().length > 60 ? focused.slice(-900) : (currentText.trim().length > 60 ? currentText.slice(0, 1200) : [req.cleanTitle, req.clip].filter(Boolean).join('. ')));

    // exclusions: current file, the caller's list, and (when unassigned) things opened in the last 15 minutes
    const excludePaths = new Set((req.exclude || []).map((p) => p.toLowerCase()));
    if (req.currentPath) excludePaths.add(req.currentPath.toLowerCase());
    if (mode !== 'task') for (const r of this.db.prepare('SELECT DISTINCT path FROM opens WHERE ts > ?').all(now - 15 * 60000)) excludePaths.add(r.path.toLowerCase());
    const titleLower = String(req.title || '').toLowerCase();

    const cands = new Map(); // docId -> candidate
    const getCand = (id) => { let c = cands.get(id); if (!c) { c = { id, bm25: 0, lexRank: null, sim: 0, chunkId: null, coopen: 0 }; cands.set(id, c); } return c; };

    // 1) keywords
    const terms = Object.keys(q.terms);
    if (terms.length) {
      // exact terms, plus prefixes for longer ones so "tourn" finds "tournament"
      const match = terms.map((t) => { const q2 = '"' + t.replace(/"/g, '') + '"'; return t.length >= 4 ? q2 + '*' : q2; }).join(' OR ');
      try {
        const rows = this.db.prepare('SELECT rowid AS id, bm25(fts, 4.0, 1.0) AS s FROM fts WHERE fts MATCH ? ORDER BY s LIMIT 60').all(match);
        rows.forEach((r, i) => { const c = getCand(r.id); c.bm25 = -r.s; c.lexRank = i; });
      } catch (e) { this.log('fts query failed', e.message); }
    }
    // 1b) file names, letters and digits only, so "nightmarket" finds "NightMarket_v3.pptx" and "night market" finds "nightmarket.txt"
    const nameWords = []; const pairParts = new Map();
    { const raw = String((mode === 'task' ? req.task : req.cleanTitle) || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      const add = (w) => { if (w.length >= 3 && !Tokenize.STOP.has(w) && !nameWords.includes(w)) nameWords.push(w); };
      raw.forEach(add); for (let i = 0; i + 1 < raw.length; i++) { const pair = raw[i] + raw[i + 1]; add(pair); pairParts.set(pair, [raw[i], raw[i + 1]]); } }
    const nameHits = new Map(); // docId -> query words found in its name
    if (nameWords.length) {
      const st = this.db.prepare("SELECT id FROM docs WHERE nname LIKE ? ESCAPE '\\' ORDER BY mtime DESC LIMIT 40");
      for (const w of nameWords.slice(0, 12)) for (const r of st.all('%' + w.replace(/[%_\\]/g, '\\$&') + '%')) {
        getCand(r.id); const hits = nameHits.get(r.id) || new Set();
        for (const part of (pairParts.get(w) || [w])) hits.add(part);
        nameHits.set(r.id, hits);
      }
    }
    const nameWordCount = Math.max(1, String((mode === 'task' ? req.task : req.cleanTitle) || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !Tokenize.STOP.has(w)).length);
    // 2) meaning
    let qv = null;
    if (this.embedder.ready && this.vectors.count() && semText.trim().length > 2) {
      try { qv = (await this.embedder.embed([semText]))[0]; for (const r of this.vectors.searchDocs(qv, 60)) { const c = getCand(r.docId); c.sim = r.sim; c.chunkId = r.chunkId; } }
      catch (e) { this.log('semantic query failed', e.message); }
    }
    // 3) opened together with the current file
    const co = req.currentPath ? this.coopen(req.currentPath, 15) : [];
    const coMax = co.length ? co[0].c : 0;
    if (co.length) {
      const st = this.db.prepare('SELECT id FROM docs WHERE path = ?');
      for (const r of co) { const d = st.get(r.path); if (d) getCand(d.id).coopen = r.c; }
    }
    let diagId = null;
    if (req.diagnosePath) { const d = this.db.prepare('SELECT id FROM docs WHERE path = ?').get(req.diagnosePath); if (d) { diagId = d.id; getCand(d.id); } }
    if (!cands.size) return { found: false, query: q.display, ms: Date.now() - t0 };

    // load docs + per-doc signals
    const ids = [...cands.keys()];
    const ph = ids.map(() => '?').join(',');
    const docs = new Map(this.db.prepare(`SELECT * FROM docs WHERE id IN (${ph})`).all(...ids).map((d) => [d.id, d]));
    const paths = [...docs.values()].map((d) => d.path); const pph = paths.map(() => '?').join(',');
    const lastOpen = new Map(paths.length ? this.db.prepare(`SELECT path, MAX(ts) t FROM opens WHERE path IN (${pph}) GROUP BY path`).all(...paths).map((r) => [r.path, r.t]) : []);
    const hist = new Map();
    if (paths.length) for (const r of this.db.prepare(`SELECT path, outcome, COUNT(*) n FROM proposals WHERE path IN (${pph}) AND ts > ? AND outcome IS NOT NULL GROUP BY path, outcome`).all(...paths, now - 30 * DAY)) {
      const h = hist.get(r.path) || { acc: 0, rej: 0 }; const l = labelFor(r.outcome); if (l) { if (l.label) h.acc += r.n; else h.rej += r.n * l.weight; } hist.set(r.path, h);
    }
    const N = Math.max(1, this.docCount());
    const df = this._df(terms);
    const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
    const totalW = terms.reduce((a, t) => a + q.terms[t] * idf(t), 0) || 1;
    const bestBm = Math.max(1e-9, ...[...cands.values()].map((c) => c.bm25));
    let bestBmCoverage = 0; // how good is the best keyword match in absolute terms?
    { let top = null; for (const c of cands.values()) if (c.bm25 > 0 && (!top || c.bm25 > top.bm25)) top = c;
      if (top) { const row = this.db.prepare('SELECT name, body FROM fts WHERE rowid = ?').get(top.id) || { name: '', body: '' }; const set = new Set((row.body + ' ' + row.name).split(' ')); bestBmCoverage = clamp01(terms.reduce((a, t) => a + (set.has(t) ? q.terms[t] * idf(t) : 0), 0) / totalW); } }
    const curDir = req.currentPath ? path.dirname(req.currentPath).toLowerCase() : null;
    const ftsRow = this.db.prepare('SELECT name, body FROM fts WHERE rowid = ?');

    const scored = [];
    for (const c of cands.values()) {
      const d = docs.get(c.id); if (!d) continue;
      if (excludePaths.has(d.path.toLowerCase()) && c.id !== diagId) continue;
      const stem = d.name.toLowerCase().replace(/\.[^.]+$/, '');
      if (!req.currentPath && titleLower && stem.length >= 5 && titleLower.includes(stem)) continue; // that's the open document
      const row = ftsRow.get(c.id) || { name: '', body: '' };
      const bodySet = new Set(row.body.split(' ')); const nameSet = new Set(row.name.split(' '));
      const exact = terms.filter((t) => bodySet.has(t) || nameSet.has(t));
      // partial words ("tourn" → "tournament") earn credit in proportion to how much of the word they cover,
      // so "tide" gets only a little for "tidewater"
      const partialCredit = new Map();
      for (const t of terms) {
        if (t.length < 4 || bodySet.has(t) || nameSet.has(t)) continue;
        let best = 0;
        for (const w of nameSet) if (w.startsWith(t)) best = Math.max(best, t.length / w.length);
        if (best < 1) for (const w of bodySet) if (w.length > t.length && w.startsWith(t)) { best = Math.max(best, t.length / w.length); if (best > 0.8) break; }
        if (best > 0) partialCredit.set(t, best * 0.6);
      }
      const matched = exact.concat([...partialCredit.keys()]);
      const matchedW = exact.reduce((a, t) => a + q.terms[t] * idf(t), 0) + [...partialCredit].reduce((a, [t, k]) => a + q.terms[t] * idf(t) * k, 0);
      const h = hist.get(d.path) || { acc: 0, rej: 0 };
      const lo = lastOpen.get(d.path);
      const f = {
        lex: c.bm25 > 0 ? clamp01(c.bm25 / bestBm) * bestBmCoverage : 0,
        coverage: clamp01(matchedW / totalW),
        nameHit: Math.max(terms.length ? terms.reduce((a, t) => a + (nameSet.has(t) ? (typeStems(d.ext).has(t) && !realNameStems(row.name, d.ext).has(t) ? 0.5 : 1) : 0), 0) / terms.length : 0, clamp01((nameHits.get(c.id) || new Set()).size / nameWordCount)),
        sem: clamp01((c.sim - 0.2) / 0.5),
        lexSem: (c.bm25 > 0 && c.sim > 0.35) ? 1 : 0,
        recency: Math.exp(-(now - d.mtime) / (30 * DAY)),
        openedRecency: lo ? Math.exp(-(now - lo) / (7 * DAY)) : 0,
        coopen: coMax ? clamp01(Math.log1p(c.coopen) / Math.log1p(Math.max(4, coMax))) : 0,
        sameFolder: curDir && path.dirname(d.path).toLowerCase() === curDir ? 1 : 0,
        rejects: clamp01(h.rej / 3), accepts: clamp01(h.acc / 3)
      };
      Object.keys(f).forEach((k) => { f[k] = +f[k].toFixed(4); });
      scored.push({ doc: d, c, f, matched, p: this.ranker.prob(f) });
    }
    scored.sort((a, b) => b.p - a.p);
    if (req.diagnosePath) {
      const i = scored.findIndex((x) => x.c.id === diagId);
      const hit = i >= 0 ? scored[i] : null;
      const evidence = hit && (hit.f.coverage > 0 || hit.f.nameHit > 0 || hit.c.sim > 0.3 || hit.f.coopen > 0);
      return { diag: hit ? { rank: i + 1, p: hit.p, f: hit.f, sim: hit.c.sim, content: hit.doc.content, matched: hit.matched.map((t) => q.words[t] || t), evidence } : null,
        top: scored.slice(0, 3).map((x) => ({ name: x.doc.name, p: +x.p.toFixed(3) })), query: q.display };
    }
    if (!scored.length) return { found: false, query: q.display, ms: Date.now() - t0 };

    const best = scored[0];
    const relevant = best.f.coverage > 0 || best.f.nameHit > 0 || best.c.sim > 0.3 || best.f.coopen > 0;
    const threshold = this.ranker.autoThreshold;
    if (!relevant || (mode === 'auto' && best.p < threshold)) {
      return { found: false, query: q.display, bestProb: +best.p.toFixed(3), threshold: +threshold.toFixed(3), ms: Date.now() - t0, top: scored.slice(0, 5).map((s) => ({ name: s.doc.name, path: s.doc.path, p: +s.p.toFixed(3), f: s.f })) };
    }

    // snippet: the chunk closest in meaning when meaning is what won, else the best keyword passage
    let snippet = '';
    if (qv && best.f.sem >= best.f.coverage && best.c.sim > 0.3) {
      const bc = this.vectors.bestChunk(qv, best.doc.id);
      const row = bc && this.db.prepare('SELECT text FROM chunks WHERE id=?').get(bc.chunkId);
      if (row) snippet = row.text.length > 320 ? row.text.slice(0, 317) + '…' : row.text;
    }
    if (!best.doc.content) snippet = ''; // name-only file: the preview picture speaks for it
    else if (!snippet) snippet = Search.bestPassage(await this.readText(best.doc.path), q.terms, q.words, 300);

    const reason = this._reason(best, mode, req);
    const id = t0 + '-' + Math.random().toString(36).slice(2, 7);
    const ctx = { task: req.task || null, title: req.title || '', cleanTitle: req.cleanTitle || '', currentPath: req.currentPath || null, clip: (req.clip || '').slice(0, 300), focusedText: focused.slice(-400), exclude: req.exclude || [] };
    this.db.prepare('INSERT OR REPLACE INTO proposals (id, ts, mode, path, prob, features, ctx) VALUES (?,?,?,?,?,?,?)')
      .run(id, now, mode, best.doc.path, best.p, JSON.stringify(best.f), JSON.stringify(ctx));
    return {
      found: true, ms: Date.now() - t0, query: q.display, alternativesLeft: scored.length - 1, threshold: +threshold.toFixed(3),
      proposal: { id, ts: now, mode, query: q.display, path: best.doc.path, name: best.doc.name, ext: best.doc.ext, dir: best.doc.dir, dirLabel: best.doc.dir.split(/[\\/]/).filter(Boolean).slice(-2).join(' › '),
        mtime: best.doc.mtime, size: best.doc.size, prob: +best.p.toFixed(3), features: best.f, matched: best.matched.map((t) => q.words[t] || t), snippet, reason },
      top: scored.slice(0, 5).map((s) => ({ name: s.doc.name, path: s.doc.path, p: +s.p.toFixed(3), f: s.f }))
    };
  }

  _reason(best, mode, req) {
    const k = this.ranker.explain(best.f);
    const words = best.matched.slice(0, 3);
    const cur = req.currentPath ? path.basename(req.currentPath) : (req.cleanTitle || 'this');
    switch (k) {
      case 'coopen': return 'You usually open this alongside ' + cur;
      case 'sem': case 'lexSem': return mode !== 'task' ? 'Close to what you’re working on' : 'Close in meaning to what you asked';
      case 'openedRecency': return 'You had this open recently';
      case 'sameFolder': return 'Sits next to ' + cur;
      case 'accepts': return 'You kept this one before';
      case 'recency': return 'Edited recently';
      default: return words.length ? 'Mentions ' + words.join(', ') : null;
    }
  }

  // ---------- previews he can make himself (Windows thumbnails are tried first, in the main process) ----------
  async preview({ path: p, width }) {
    const ext = path.extname(p).toLowerCase(); width = width || 640;
    try {
      if (ext === '.pdf') {
        // pdf.js draws with browser classes; inside Electron's background process they must come from the canvas package
        const PDFParse = extract.PDF();
        const parser = new PDFParse({ data: fs.readFileSync(p) });
        try {
          const r = await Promise.race([parser.getScreenshot({ partial: [1], desiredWidth: width, imageDataUrl: true, imageBuffer: false }), new Promise((res) => setTimeout(() => res(null), 8000))]);
          const pg = r && r.pages && r.pages[0];
          return pg && pg.dataUrl ? { kind: 'page', dataUrl: pg.dataUrl, width: pg.width, height: pg.height } : null;
        } finally { try { await parser.destroy(); } catch (e) {} }
      }
      if (['.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods'].includes(ext)) {
        // Office and LibreOffice save a cover image inside the file (PowerPoint by default: the first slide)
        const AdmZip = require('adm-zip'); const zip = new AdmZip(p);
        for (const n of ['docProps/thumbnail.jpeg', 'docProps/thumbnail.jpg', 'docProps/thumbnail.png', 'Thumbnails/thumbnail.png']) {
          const e = zip.getEntry(n); if (!e) continue;
          const buf = e.getData(); if (buf.length < 200) continue;
          return { kind: 'cover', dataUrl: 'data:image/' + (n.endsWith('png') ? 'png' : 'jpeg') + ';base64,' + buf.toString('base64') };
        }
      }
    } catch (e) { this.log('preview failed for', path.basename(p), e.message); }
    return null;
  }

  // ---------- "you missed one": explain, fix, learn ----------
  async diagnose({ path: p, request }) {
    const name = path.basename(p); const out = { path: p, name };
    let st; try { st = fs.statSync(p); } catch (e) { return Object.assign(out, { verdict: 'missing', message: name + ' no longer exists.' }); }
    const lower = p.toLowerCase();
    const root = this.roots.find((r) => lower === r.toLowerCase() || lower.startsWith(r.toLowerCase().replace(/[\\/]+$/, '') + path.sep));
    if (!root) return Object.assign(out, { verdict: 'outside', folder: path.dirname(p),
      message: 'I never looked in ' + path.dirname(p) + '. It isn\u2019t one of the folders I search. Add it and I\u2019ll read everything in it.' });
    const seg = p.slice(root.length).split(/[\\/]/).slice(0, -1).find((x) => x && (x.startsWith('.') || EXCLUDED_DIRS.has(x.toLowerCase())));
    if (seg) return Object.assign(out, { verdict: 'excluded', message: 'It\u2019s inside a \u201c' + seg + '\u201d folder. I skip those because they usually hold caches or generated files.' });
    const v = verdict(name, st, this.cloudCheck);
    if (v === 'skip') return Object.assign(out, { verdict: 'skipped-type', message: 'I skip ' + (path.extname(name) || 'extension-less') + ' files; they\u2019re usually system or temporary files.' });
    let row = this.db.prepare('SELECT * FROM docs WHERE path = ?').get(p);
    let indexedNow = false;
    if (!row || row.mtime !== Math.round(st.mtimeMs)) { await this.indexFile(p, st, v); indexedNow = true; row = this.db.prepare('SELECT * FROM docs WHERE path = ?').get(p); if (this.embedder.ready) this._embedLoop(); }
    const how = v === 'name' ? (this.cloudCheck && st.blocks === 0 && st.size > 4096 ? ' It\u2019s online-only in OneDrive, so I go by its name and don\u2019t download it.' : ' I can\u2019t read inside ' + (path.extname(name) || 'this kind of') + ' files, so I go by its name.') : '';
    if (!request || !(request.task || request.cleanTitle || request.currentPath)) {
      return Object.assign(out, { verdict: 'indexed', message: (indexedNow ? 'I hadn\u2019t read it yet. I have now, so ask me again.' : 'I know this file. Ask me for it again.') + how });
    }
    await this.embedIdleFor(row.id);
    const res = await this.search(Object.assign({}, request, { exclude: [], diagnosePath: p }));
    const d = res.diag; const ask = request.task ? '\u201c' + request.task + '\u201d' : 'what you were working on';
    let message;
    if (!d || !d.evidence) message = 'Nothing in ' + ask + ' connected to it: not the words, its name, or its meaning.' + how + ' Next time, try a word from its name.';
    else if (d.rank === 1) message = (indexedNow ? 'I hadn\u2019t read it yet. Now I\u2019d bring it first for ' : 'I\u2019d bring it first for ') + ask + ' now.' + how;
    else message = 'It came ' + ordinal(d.rank) + ' for ' + ask + (res.top && res.top[0] ? ', behind ' + res.top[0].name : '') + '. ' + (d.matched.length ? 'It matched ' + d.matched.slice(0, 3).join(', ') + '.' : 'It matched by meaning, not by your words.') + how + ' I\u2019ll weigh things like this more from now on.';
    // learn from it: this file, for this request, was the right answer
    if (d) {
      const id = 'missed-' + Date.now();
      this.db.prepare('INSERT INTO proposals (id, ts, mode, path, prob, features, ctx, outcome, outcome_ts) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, Date.now(), request.mode || 'task', p, d.p, JSON.stringify(d.f), JSON.stringify({ task: request.task || null, cleanTitle: request.cleanTitle || '', currentPath: request.currentPath || null, exclude: [] }), 'missed', Date.now());
      this.retrain();
    }
    return Object.assign(out, { verdict: 'ranked', rank: d ? d.rank : null, message });
  }
  async embedIdleFor(docId) {
    for (let i = 0; i < 50; i++) { if (!this.embedder.ready) return; const n = this.db.prepare('SELECT COUNT(*) n FROM chunks WHERE doc_id = ? AND vec IS NULL').get(docId).n; if (!n) return; this._embedLoop(); await new Promise((r) => setTimeout(r, 100)); }
  }

  // ---------- learning ----------
  outcome(id, outcome) {
    const r = this.db.prepare('SELECT * FROM proposals WHERE id=?').get(id);
    if (!r) return null;
    this.db.prepare('UPDATE proposals SET outcome=?, outcome_ts=? WHERE id=?').run(outcome, Date.now(), id);
    if (outcome === 'accept' || outcome === 'reveal') this.opened(r.path, Date.now(), 'gofer');
    return this.retrain();
  }
  retrain() {
    const rows = this.db.prepare('SELECT mode, features, outcome FROM proposals WHERE outcome IS NOT NULL ORDER BY ts DESC LIMIT 3000').all();
    const ex = [];
    for (const r of rows) { const l = labelFor(r.outcome); if (!l) continue; ex.push({ features: JSON.parse(r.features), label: l.label, weight: l.weight, mode: r.mode }); }
    this.ranker = new Ranker(Object.assign(this.ranker.toJSON(), {}));
    this.ranker.train(ex);
    this.ranker.calibrate(ex.filter((e) => e.mode === 'auto' || e.mode === 'live'), this.autoTarget);
    DB.setMeta(this.db, 'ranker', this.ranker.toJSON());
    return this.ranker.toJSON();
  }
  summary() {
    const rows = this.db.prepare("SELECT mode, outcome, COUNT(*) n FROM proposals WHERE outcome IS NOT NULL AND outcome <> 'missed' GROUP BY mode, outcome").all();
    const out = { total: 0, kept: 0, byMode: {} };
    for (const r of rows) { out.total += r.n; const l = labelFor(r.outcome); if (l && l.label) out.kept += r.n; const m = out.byMode[r.mode] = out.byMode[r.mode] || { total: 0, kept: 0 }; m.total += r.n; if (l && l.label) m.kept += r.n; }
    out.rate = out.total ? out.kept / out.total : 0;
    return out;
  }
  history(limit) { return this.db.prepare('SELECT * FROM proposals WHERE outcome IS NOT NULL ORDER BY ts DESC LIMIT ?').all(limit || 1000).map((r) => Object.assign(r, { features: JSON.parse(r.features), ctx: JSON.parse(r.ctx || '{}') })); }
}

module.exports = { Engine, chunkText, EXCLUDED_DIRS, verdict, normName };
