'use strict';
/* Findability checks: files he couldn't see or match before. Runs on a temp copy of the fixtures. */
const path = require('path'), fs = require('fs'), os = require('os');
const AdmZip = require('adm-zip');
const { Engine, verdict } = require('../src/engine/engine');

const src = process.argv[2] || path.join(__dirname, '..', 'tests', 'fixtures');
const modelDir = process.argv[3] || path.join(__dirname, '..', 'model');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gofer-find-'));
fs.cpSync(src, work, { recursive: true });
const D = path.join(work, 'Documents');
let failed = 0; const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };

// new files that used to be invisible
fs.writeFileSync(path.join(D, 'Projects', 'HarvestMarket_Thumbnail_v3.png'), Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db40000000049454e44ae426082', 'hex'));
fs.writeFileSync(path.join(D, 'Games', 'lantern_cover_painting.psd'), Buffer.alloc(9000, 1));
fs.mkdirSync(path.join(D, 'Games', 'build'), { recursive: true });
fs.writeFileSync(path.join(D, 'Games', 'build', 'release_notes.txt'), 'Release notes for the flamingo patch: fixed the heron boss.');
fs.mkdirSync(path.join(D, 'Games', 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(D, 'Games', 'node_modules', 'junk.txt'), 'flamingo flamingo flamingo');
const big = new AdmZip();
big.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
big.addFile('word/document.xml', Buffer.from('<w:document><w:body><w:p><w:r><w:t>Sponsor activation plan for the marmalade festival booth.</w:t></w:r></w:p></w:body></w:document>'));
big.addFile('word/media/image1.png', require('crypto').randomBytes(9.5e6)); // > the old 8 MB limit
big.writeZip(path.join(D, 'Projects', 'big_sponsor_deck.docx'));
const longText = 'Opening notes about nothing in particular. '.repeat(2000) + ' The zeppelin chapter starts here.';
fs.writeFileSync(path.join(D, 'long_notes.txt'), longText); // keyword far past 60,000 characters
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gofer-outside-'));
fs.writeFileSync(path.join(outside, 'stray_idea.txt'), 'A stray idea about lighthouses.');

(async () => {
  const dbFile = path.join(work, 'test.db');
  const e = new Engine({ dbFile, modelDir, roots: [D, path.join(work, 'Desktop')], log: () => {} });
  e.init(); await e.scan(); await e.embedder.load(); await e.embedIdle();
  const find = async (task) => { const r = await e.search({ mode: 'task', task }); return r.found ? r.proposal.name : null; };

  ok(verdict('x.png', { size: 10 }) === 'name' && verdict('x.exe', { size: 10 }) === 'skip' && verdict('x.docx', { size: 9e6 }) === 'full', 'indexing rules: images by name, programs skipped, 9 MB docx read');
  ok(await find('harvest market thumbnail') === 'HarvestMarket_Thumbnail_v3.png', 'image found by words in its name');
  ok(await find('harvestmarket thumbnail') === 'HarvestMarket_Thumbnail_v3.png', '"harvestmarket" matches "HarvestMarket"');
  ok(await find('harvestmarketthumb') === 'HarvestMarket_Thumbnail_v3.png' || await find('harvest thumb') === 'HarvestMarket_Thumbnail_v3.png', 'partial name matches');
  ok(await find('lantern cover psd') === 'lantern_cover_painting.psd', 'Photoshop file found by name');
  ok(await find('marmalade festival') === 'big_sponsor_deck.docx', 'Word file over 8 MB is read');
  ok(await find('zeppelin chapter') === 'long_notes.txt', 'word 86,000 characters into a file is found');
  ok(await find('musici fees') === 'market_budget.xlsx', '"musici" finds "musician"');
  ok(await find('flamingo patch') === 'release_notes.txt', 'files in a "build" folder are found');
  const fl = await e.search({ mode: 'task', task: 'flamingo flamingo' });
  ok(!(fl.top || []).some((t) => t.path.includes('node_modules')), 'node_modules still skipped');
  ok(await find('the deck for the night market') !== null, 'regression: ordinary request still works');

  // "he missed one"
  let d = await e.diagnose({ path: path.join(outside, 'stray_idea.txt'), request: { mode: 'task', task: 'lighthouses' } });
  ok(d.verdict === 'outside' && d.folder === outside, 'missed file outside the folders → offers to add the folder');
  console.log('     "' + d.message + '"');
  d = await e.diagnose({ path: path.join(D, 'Games', 'node_modules', 'junk.txt'), request: { mode: 'task', task: 'flamingo' } });
  ok(d.verdict === 'excluded', 'missed file in node_modules → explains the skipped folder');
  console.log('     "' + d.message + '"');
  const req = { mode: 'task', task: 'rules for the game' };
  const before = await e.search(req);
  console.log('     "rules for the game" → ' + (before.found ? before.proposal.name : 'nothing'));
  const target = path.join(D, 'Games', 'tiny_kingdoms_format.md');
  d = await e.diagnose({ path: target, request: req });
  ok(d.verdict === 'ranked' && /came|first/.test(d.message), 'missed file that ranked low → explains where it came');
  console.log('     "' + d.message + '"');
  const trained = e.ranker.trainedOn;
  ok(trained >= 1, 'the miss was recorded as a training example');
  ok(e.summary().total === 0, '"missed" corrections don\'t inflate the kept-rate');
  e.close();
  console.log(failed ? '\n' + failed + ' FAILED' : '\nALL FINDABILITY CHECKS PASSED');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error(err); process.exit(1); });
