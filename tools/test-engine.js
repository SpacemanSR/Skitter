'use strict';
/* Headless engine check: index fixtures, embed, run keyword / meaning / context / co-open cases, train the ranker. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Engine } = require('../src/engine/engine');

const root = process.argv[2] || '/home/claude/fixtures';
const modelDir = process.argv[3] || '/home/claude/devmodel';
const dbFile = path.join(os.tmpdir(), 'gofer-engine-test.db');
for (const s of ['', '-wal', '-shm']) try { fs.unlinkSync(dbFile + s); } catch (e) {}

const ok = (c, msg) => { console.log((c ? '  PASS ' : '  FAIL ') + msg); if (!c) process.exitCode = 1; };

(async () => {
  const e = new Engine({ dbFile, modelDir, roots: [path.join(root, 'Documents'), path.join(root, 'Desktop')], log: (...a) => console.log('   [engine]', ...a) });
  e.init();
  await e.scan();
  await e.embedder.load();
  await e.embedIdle();
  const st = e.stats(); console.log('stats', JSON.stringify({ count: st.count, chunks: st.chunks, embedded: st.embeddedChunks, semantic: st.semantic }));

  const run = async (label, req) => { const r = await e.search(req); console.log('\n' + label + '  (' + r.ms + 'ms)'); if (r.top) r.top.slice(0, 3).forEach((t) => console.log('   ' + t.p.toFixed(3) + '  ' + t.name.padEnd(36) + JSON.stringify(t.f))); if (r.proposal) console.log('   reason: ' + r.proposal.reason + '\n   snippet: ' + JSON.stringify(r.proposal.snippet.slice(0, 140))); else console.log('   -> nothing', r.bestProb != null ? '(best ' + r.bestProb + ' < ' + r.threshold + ')' : ''); return r; };

  let r = await run('TASK keywords: "harvest market deck"', { mode: 'task', task: 'harvest market deck' });
  ok(r.found && /harvest_market/.test(r.proposal.name), 'keyword task finds a harvest market file');

  r = await run('TASK meaning only: "how much will the event cost to put on"', { mode: 'task', task: 'how much will the event cost to put on' });
  ok(r.found && r.proposal.name === 'market_budget.xlsx', 'meaning-only task finds the budget');

  const pitch = path.join(root, 'Documents/Games/LANTERN_KEEPER_design.md');
  const resolved = e.resolveFile({ title: 'LANTERN_KEEPER_design.md - Obsidian', recent: [] });
  ok(resolved === pitch, 'resolves window title to the open file');
  const resolved2 = e.resolveFile({ title: 'Riverfest_run_of_show - Word', recent: [] });
  ok(resolved2 && resolved2.endsWith('Riverfest_run_of_show.docx'), 'resolves extension-less Word title by stem');

  r = await run('AUTO from open file content (LANTERN design doc open)', { mode: 'auto', title: 'LANTERN_KEEPER_design.md - Obsidian', cleanTitle: 'LANTERN_KEEPER_design', currentPath: pitch });
  ok(!r.found || r.proposal.path !== pitch, 'never brings back the open file');
  ok(r.top && /tidal/.test(r.top[0].name), 'open-file content ranks the tertiary tidal-steps note first');
  ok(!r.found, 'weak evidence stays below the unassigned-trip bar');

  r = await run('AUTO from focused text (writing an email about sponsor money)', { mode: 'auto', title: 'Re: sponsor - Gmail', cleanTitle: 'Re: sponsor', focusedText: 'Hi team, before we lock the bakery partnership I need the numbers: what are we paying the musicians and how much goes to the venue?' });
  ok(r.found && /budget|harvest/.test(r.proposal.name), 'focused text drives a relevant pick');

  // co-open: you always open the card rules next to the board-game format
  const kingdoms = path.join(root, 'Documents/Games/tiny_kingdoms_format.md'), dice = path.join(root, 'Documents/Games/card_game_rules.txt');
  const t = Date.now() - 10 * 86400000;
  for (let i = 0; i < 4; i++) { e.opened(kingdoms, t + i * 86400000, 'test'); e.opened(dice, t + i * 86400000 + 5 * 60000, 'test'); }
  ok(e.coopen(kingdoms)[0] && e.coopen(kingdoms)[0].path === dice, 'co-open history links board game → card rules');
  r = await run('AUTO with board-game format open', { mode: 'auto', title: 'tiny_kingdoms_format.md - Notepad', cleanTitle: 'tiny_kingdoms_format', currentPath: kingdoms });
  ok(r.found && r.proposal.name === 'card_game_rules.txt', 'opened-together pick wins');

  // learning: a run of accepted and rejected fetches
  const before = e.ranker.toJSON().w.rejects;
  for (let i = 0; i < 18; i++) {
    await e.embedIdle(); const res = await e.search({ mode: 'task', task: i % 2 ? 'harvest market deck' : 'lantern lens level design' });
    if (res.found) e.outcome(res.proposal.id, i % 3 === 0 ? 'retry' : 'accept');
  }
  const after = e.retrain();
  console.log('\nranker after training:', JSON.stringify(after.w), 'trainedOn', after.trainedOn);
  ok(after.trainedOn >= 15, 'ranker trained on logged outcomes');
  console.log('summary', JSON.stringify(e.summary()));
  void before;

  // watcher: add a new file and see it indexed
  e.watch();
  const newFile = path.join(root, 'Documents/Games/new_idea_hovercraft.txt');
  fs.writeFileSync(newFile, 'Hovercraft racing idea: skimming over flooded city streets, boost from wake surfing.');
  await new Promise((res) => setTimeout(res, 2600));
  r = await e.search({ mode: 'task', task: 'hovercraft wake surfing' });
  ok(r.found && r.proposal.name === 'new_idea_hovercraft.txt', 'watcher indexed a newly created file');
  fs.unlinkSync(newFile);
  await new Promise((res) => setTimeout(res, 2600));
  r = await e.search({ mode: 'task', task: 'hovercraft wake surfing' });
  ok(!r.found || r.proposal.name !== 'new_idea_hovercraft.txt', 'watcher dropped the deleted file');
  e.close();
  console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
})().catch((err) => { console.error(err); process.exit(1); });
