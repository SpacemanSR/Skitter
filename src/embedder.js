'use strict';
/* Local sentence embeddings: all-MiniLM-L6-v2 (quantized ONNX) on ONNX Runtime's WebAssembly backend.
   No native modules, so the same code runs on Windows, macOS and Linux. Output: 384-d unit vectors. */
const fs = require('fs');
const path = require('path');

const MODEL_FILES = {
  model: { file: 'model_quantized.onnx', url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx', minBytes: 20e6 },
  vocab: { file: 'vocab.txt', url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/vocab.txt', minBytes: 200e3 }
};
const DIM = 384;
const MAX_TOKENS = 128;

// ---------- BERT uncased WordPiece tokenizer ----------
class WordPiece {
  constructor(vocabText) {
    this.vocab = new Map();
    vocabText.split(/\r?\n/).forEach((tok, i) => { if (tok) this.vocab.set(tok, i); });
    this.cls = this.vocab.get('[CLS]'); this.sep = this.vocab.get('[SEP]'); this.unk = this.vocab.get('[UNK]'); this.pad = this.vocab.get('[PAD]') || 0;
  }
  basic(text) {
    const s = String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/([一-鿿])/g, ' $1 ');
    const out = [];
    for (const w of s.split(/\s+/)) {
      if (!w) continue;
      let cur = '';
      for (const ch of w) {
        if (/[\p{P}\p{S}]/u.test(ch)) { if (cur) out.push(cur); out.push(ch); cur = ''; }
        else cur += ch;
      }
      if (cur) out.push(cur);
    }
    return out;
  }
  wordpiece(word) {
    if (word.length > 100) return [this.unk];
    const ids = []; let start = 0;
    while (start < word.length) {
      let end = word.length, found = -1;
      while (start < end) {
        const sub = (start > 0 ? '##' : '') + word.slice(start, end);
        const id = this.vocab.get(sub);
        if (id !== undefined) { found = id; break; }
        end--;
      }
      if (found < 0) return [this.unk];
      ids.push(found); start = end;
    }
    return ids;
  }
  encode(text, maxLen) {
    const ids = [this.cls];
    for (const w of this.basic(text)) { for (const id of this.wordpiece(w)) { if (ids.length >= maxLen - 1) break; ids.push(id); } if (ids.length >= maxLen - 1) break; }
    ids.push(this.sep);
    return ids;
  }
}

class Embedder {
  constructor(opts) {
    this.dir = opts.modelDir;
    this.log = opts.log || (() => {});
    this.session = null; this.tok = null; this.ready = false; this.failed = null;
    this._loading = null;
  }
  filesPresent() {
    return Object.values(MODEL_FILES).every((f) => { try { return fs.statSync(path.join(this.dir, f.file)).size >= f.minBytes; } catch (e) { return false; } });
  }
  async download(onProgress) {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const f of Object.values(MODEL_FILES)) {
      const dest = path.join(this.dir, f.file);
      try { if (fs.statSync(dest).size >= f.minBytes) continue; } catch (e) {}
      this.log('downloading', f.url);
      const res = await fetch(f.url, { redirect: 'follow' });
      if (!res.ok) throw new Error('download failed ' + res.status + ' for ' + f.file);
      const total = Number(res.headers.get('content-length')) || 0;
      const chunks = []; let got = 0;
      const reader = res.body.getReader();
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); got += value.length; if (onProgress && total) onProgress(f.file, got / total); }
      const buf = Buffer.concat(chunks);
      if (buf.length < f.minBytes) throw new Error('download too small for ' + f.file);
      fs.writeFileSync(dest + '.part', buf); fs.renameSync(dest + '.part', dest);
    }
  }
  load() {
    if (this._loading) return this._loading;
    this._loading = (async () => {
      try {
        if (!this.filesPresent()) await this.download();
        const ort = require('onnxruntime-web');
        ort.env.wasm.numThreads = 1;          // background work; keep one core
        ort.env.logLevel = 'error';
        const wasmDir = path.dirname(require.resolve('onnxruntime-web')) + path.sep;
        ort.env.wasm.wasmPaths = wasmDir;
        this.tok = new WordPiece(fs.readFileSync(path.join(this.dir, MODEL_FILES.vocab.file), 'utf8'));
        const modelBytes = fs.readFileSync(path.join(this.dir, MODEL_FILES.model.file));
        this.session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
        this.ort = ort; this.inputNames = this.session.inputNames;
        this.ready = true; this.log('embedder ready');
      } catch (e) {
        this.failed = e.message; this.log('embedder unavailable:', e.message);
      }
      return this.ready;
    })();
    return this._loading;
  }
  /* texts: string[] → Float32Array[] (unit length). Batches internally. */
  async embed(texts) {
    if (!this.ready) throw new Error('embedder not ready');
    const out = [];
    const B = 16;
    for (let i = 0; i < texts.length; i += B) {
      const batch = texts.slice(i, i + B).map((t) => this.tok.encode(t, MAX_TOKENS));
      const L = Math.max(...batch.map((b) => b.length));
      const ids = new BigInt64Array(batch.length * L), mask = new BigInt64Array(batch.length * L), types = new BigInt64Array(batch.length * L);
      batch.forEach((b, r) => { for (let j = 0; j < L; j++) { ids[r * L + j] = BigInt(j < b.length ? b[j] : this.tok.pad); mask[r * L + j] = j < b.length ? 1n : 0n; } });
      const feeds = {};
      const T = this.ort.Tensor;
      for (const name of this.inputNames) {
        if (name === 'input_ids') feeds[name] = new T('int64', ids, [batch.length, L]);
        else if (name === 'attention_mask') feeds[name] = new T('int64', mask, [batch.length, L]);
        else if (name === 'token_type_ids') feeds[name] = new T('int64', types, [batch.length, L]);
      }
      const res = await this.session.run(feeds);
      const hidden = res.last_hidden_state || res[this.session.outputNames[0]];
      const data = hidden.data; const H = hidden.dims[2];
      batch.forEach((b, r) => {
        const v = new Float32Array(H); const n = b.length;
        for (let j = 0; j < n; j++) { const off = (r * L + j) * H; for (let k = 0; k < H; k++) v[k] += data[off + k]; }
        let norm = 0; for (let k = 0; k < H; k++) { v[k] /= n; norm += v[k] * v[k]; }
        norm = Math.sqrt(norm) || 1; for (let k = 0; k < H; k++) v[k] /= norm;
        out.push(v);
      });
    }
    return out;
  }
}

/* int8 quantization for storage: unit vectors, components in [-1, 1] */
function quantize(v) { const q = new Int8Array(v.length); for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i] * 127))); return q; }

module.exports = { Embedder, WordPiece, quantize, DIM, MODEL_FILES };
