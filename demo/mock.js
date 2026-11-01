/* Mock host for the web demo: a pretend desktop with a pretend Documents folder.
   Same tokenizer and ranking as the Windows build; only the files are made up. */
(function () {
  'use strict';
  const DAY = 86400000;
  const corpus = [
    { name: 'LANTERN_KEEPER_design.md', dir: 'Documents › Games', days: 3, text: 'LANTERN//KEEPER design notes. A moody puzzle game about a lighthouse keeper who restores old lenses. The player grinds lenses and refracts light onto shipwrecks; each rescue leaves a lens behind as the next level. Art direction: deep teal, brass, sea fog, the 2024 sketch series as the reference book.' },
    { name: 'LANTERN_palette_and_shader_notes.txt', dir: 'Documents › Games › Art', days: 9, text: 'Palette for LANTERN: teal 0f3b40, brass highlights, warm amber beam used sparingly. Fog shader with slight bloom. Sketches are imported at 2k and quantized to 32 colors so the pencil texture survives.' },
    { name: 'harvest_market_pitch.txt', dir: 'Documents › Projects', days: 4, text: 'Harvest Night Market pitch — one night only, 32 vendor stalls, two stages, four sets per night. Sponsorship targets: Juniper & Rye bakery, Tidewater Credit Union. Stage plan: two hosts, one MC, live music between sets. Stall map and layout live in harvest_market_deck.pptx.' },
    { name: 'harvest_market_deck.pptx', dir: 'Documents › Projects', days: 2, text: 'Harvest Night Market. One night, thirty-two stalls. Sponsors: Juniper & Rye as bakery partner, Tidewater Credit Union as community partner. Format: 32 vendor stalls, two stages, four sets per night. Run time: 6 hours, two hosts, one MC.' },
    { name: 'market_budget.xlsx', dir: 'Documents › Projects', days: 6, text: 'Budget. Vendors. Musician fees. Juniper & Rye activation. Venue. Lighting package. Stage hire. Contingency 10 percent.' },
    { name: 'card_game_rules.txt', dir: 'Documents › Games', days: 15, text: 'Card combination game. Draw five cards, combine suits into runs, play the probabilities. Runs beat pairs; a full set is worth triple. The risk ladder: every redraw costs one card.' },
    { name: 'tiny_kingdoms_format.md', dir: 'Documents › Games', days: 10, text: 'Tiny Kingdoms: an abbreviated strategy board game format in the spirit of a draft. Sessions run 15 to 60 minutes. Players draft pieces from a shared pool before the game. Presentation: a 3D wooden table, felt and brass.' },
    { name: 'asteroid_td_roguelike.pdf', dir: 'Documents › Games', days: 48, text: 'Asteroid tower defense roguelike. Waves descend; the towers are the old satellites turned around. Art direction: arcade CRT bloom, pixel sprites. Runs reset with new tower unlocks.' },
    { name: 'tidal_steps_notes.txt', dir: 'Documents › Writing', days: 17, text: 'Tidal Steps model: the sea retreats in discrete steps, not smoothly. Essay draft two. Tertiary idea: the steps as a metaphor for level design, where each step is a recovered lens, which ties straight back to LANTERN.' },
    { name: 'essay_outline_shipwrecks.md', dir: 'Documents › Essays', days: 58, text: 'Video essay outline: why shipwreck stories are really about the people on shore. Thesis first, then three sequences. Pair with the lighthouse essay on duty as a debt you inherit.' },
    { name: 'podcast_prep_notes.txt', dir: 'Documents › Projects', days: 30, text: 'Podcast prep. Guest list, segment notes, storylines for the episode, vendor logistics talking points, and how to keep the interview on time.' },
    { name: 'sea_shanty_reference_tracks.txt', dir: 'Documents › Games › Art', days: 21, text: 'Reference tracks for the LANTERN soundtrack: slow concertina, foghorn swells, a brass bell. Tempo 70 to 80. Keep the lens cues wordless.' }
  ];
  const docs = corpus.map((c, i) => {
    const ext = c.name.slice(c.name.lastIndexOf('.'));
    const base = c.name.slice(0, -ext.length);
    const toks = Tokenize.tokenize(c.text);
    return { path: c.dir + '/' + c.name, name: c.name, ext, dir: c.dir, dirLabel: c.dir, mtime: Date.now() - c.days * DAY, size: c.text.length, len: toks.length, tf: Tokenize.termFreq(toks), ntf: Tokenize.termFreq(Tokenize.tokenize(base + ' ' + c.dir)), text: c.text, id: i };
  });
  const df = new Map(); let total = 0;
  for (const d of docs) { total += d.len; const seen = new Set([...Object.keys(d.tf), ...Object.keys(d.ntf)]); for (const t of seen) df.set(t, (df.get(t) || 0) + 1); }
  const index = { docs, df, avgLen: total / docs.length };

  const listeners = {};
  const state = { title: '', context: '', tally: { accept: 0, reveal: 0, retry: 0, ignore: 0, dismiss: 0 }, proposals: new Map(), lastFetch: 0 };
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const toast = (msg, ms) => { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms || 2600); };

  window.gofer = {
    platform: 'web',
    setInteractive(on) { document.getElementById('stage').classList.toggle('live', !!on); },
    focus() {}, mode() {}, saveUi() {},
    menu() { toast('On Windows this opens the tray menu: folders, auto mode, rebuild index, hit rate.'); },
    getState: async () => ({ ready: true, count: docs.length, presentTimeoutSec: 14, eyelineFrac: 0.2, firstRun: true, tripPace: 'brisk' }),
    on(ch, fn) { (listeners[ch] = listeners[ch] || []).push(fn); return () => { listeners[ch] = (listeners[ch] || []).filter((f) => f !== fn); }; },
    emit(ch, data) { (listeners[ch] || []).forEach((fn) => fn(data)); },
    async fetch(req) {
      await delay(600 + Math.random() * 700);
      const mode = req.mode || 'task';
      const q = mode === 'task'
        ? Search.buildQuery([{ text: req.task || '', weight: 1.6 }, { text: state.context, weight: 0.3 }])
        : Search.buildQuery([{ text: state.context, weight: 2 }]);
      const cands = Search.rank(index, q.terms, { exclude: req.exclude || [], currentTitle: state.title, limit: 6 });
      state.lastFetch = Date.now();
      if (!cands.length || (mode === 'auto' && cands[0].coverage < 0.35)) return { found: false, query: q.display };
      const pick = cands[0]; const d = pick.doc;
      const p = { id: 'p' + Date.now() + Math.random().toString(36).slice(2, 6), ts: Date.now(), mode, query: q.display, path: d.path, name: d.name, ext: d.ext, dir: d.dir, dirLabel: d.dirLabel, mtime: d.mtime,
        matched: pick.matched.map((t) => q.words[t] || t), snippet: Search.bestPassage(d.text, q.terms, q.words, 260) };
      const words = p.matched.slice(0, 3); p.reason = words.length ? 'Mentions ' + words.join(', ') : null;
      state.proposals.set(p.id, d);
      return { found: true, proposal: p, alternativesLeft: cands.length - 1 };
    },
    async preview() { return null; },
    async decide(dec) {
      const d = state.proposals.get(dec.id);
      if (dec.outcome in state.tally) state.tally[dec.outcome]++;
      window.gofer.emit('tally', state.tally);
      if (d && (dec.outcome === 'accept' || dec.outcome === 'reveal')) window.gofer.emit('open-doc', d);
    },
    demo: { state, docs, toast }
  };
})();
