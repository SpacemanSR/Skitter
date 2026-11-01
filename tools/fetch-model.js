'use strict';
/* Fetch the embedding model into ./model, pinned and verified.
     node tools/fetch-model.js            use model.lock.json if present; otherwise create it (see below)
     node tools/fetch-model.js --require-lock   fail if there is no lock (use once the lock is committed)
   With a lock: downloads exactly that Hugging Face commit and checks each file's SHA-256 against the lock.
   Without a lock: resolves the current commit of the repo, checks each download against the hashes
   Hugging Face publishes for that commit (LFS sha256 / git blob sha1), then writes model.lock.json.
   Commit model.lock.json; from then on every build is byte-for-byte the same model. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'model');
const LOCK = path.join(ROOT, 'model.lock.json');
const REPO = 'Xenova/all-MiniLM-L6-v2';
const FILES = [{ remote: 'onnx/model_quantized.onnx', local: 'model_quantized.onnx' }, { remote: 'vocab.txt', local: 'vocab.txt' }];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const gitBlobSha1 = (buf) => crypto.createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex');

async function getJson(url) { const r = await fetch(url, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(url + ' → HTTP ' + r.status); return r.json(); }
async function getBuf(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { const r = await fetch(url, { redirect: 'follow' }); if (!r.ok) throw new Error('HTTP ' + r.status); return Buffer.from(await r.arrayBuffer()); }
    catch (e) { if (attempt === 3) throw new Error(url + ' → ' + e.message); await new Promise((res) => setTimeout(res, 2000 * attempt)); }
  }
}

/* Hashes Hugging Face publishes for files at a commit: { path: { sha256?, sha1?, size } } */
async function publishedHashes(revision) {
  const out = {};
  for (const dir of ['', 'onnx']) {
    const list = await getJson(`https://huggingface.co/api/models/${REPO}/tree/${revision}${dir ? '/' + dir : ''}`);
    for (const e of list) if (e.type === 'file') out[e.path] = { size: e.size, sha1: e.oid, sha256: e.lfs && e.lfs.oid };
  }
  return out;
}

function verifyAgainstPublished(buf, pub, name) {
  if (!pub) throw new Error('Hugging Face lists no file ' + name);
  if (pub.sha256) { if (sha256(buf) !== pub.sha256) throw new Error(name + ': SHA-256 does not match Hugging Face'); }
  else if (gitBlobSha1(buf) !== pub.sha1) throw new Error(name + ': git blob hash does not match Hugging Face');
}

async function main() {
  const requireLock = process.argv.includes('--require-lock');
  fs.mkdirSync(OUT, { recursive: true });
  let lock = null; try { lock = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch (e) {}
  if (!lock && requireLock) throw new Error('model.lock.json is missing. Run without --require-lock once and commit the lock.');

  // already present and matching the lock? nothing to do
  if (lock && FILES.every((f) => { try { return sha256(fs.readFileSync(path.join(OUT, f.local))) === lock.files[f.remote].sha256; } catch (e) { return false; } })) {
    console.log('model up to date (' + REPO + ' @ ' + lock.revision.slice(0, 10) + ')'); return;
  }

  let revision = lock && lock.revision;
  let pub = null;
  if (!lock) { revision = (await getJson(`https://huggingface.co/api/models/${REPO}/revision/main`)).sha; pub = await publishedHashes(revision); console.log('pinning ' + REPO + ' @ ' + revision); }

  const files = {};
  for (const f of FILES) {
    const buf = await getBuf(`https://huggingface.co/${REPO}/resolve/${revision}/${f.remote}`);
    if (lock) { if (sha256(buf) !== lock.files[f.remote].sha256) throw new Error(f.remote + ': SHA-256 does not match model.lock.json. Refusing to use it.'); }
    else verifyAgainstPublished(buf, pub[f.remote], f.remote);
    fs.writeFileSync(path.join(OUT, f.local), buf);
    files[f.remote] = { sha256: sha256(buf), size: buf.length };
    console.log('  ✓ ' + f.remote + '  ' + (buf.length / 1e6).toFixed(1) + ' MB  sha256 ' + files[f.remote].sha256.slice(0, 16) + '…');
  }
  if (!lock) {
    fs.writeFileSync(LOCK, JSON.stringify({ repo: REPO, revision, files, pinnedAt: new Date().toISOString() }, null, 2) + '\n');
    console.log('\nwrote model.lock.json. Commit it so every future build uses exactly this model.');
    if (process.env.GITHUB_ACTIONS) console.log('::warning::model.lock.json was created by this run. Download it from the run artifacts and commit it.');
  }
}

module.exports = { sha256, gitBlobSha1, verifyAgainstPublished };
if (require.main === module) main().catch((e) => { console.error('fetch-model: ' + e.message); process.exit(1); });
