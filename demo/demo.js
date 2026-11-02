/* Demo page glue: a pretend document window. Switching documents changes the context; Skitter may go on his own. */
(function () {
  'use strict';
  const g = window.gofer, S = g.demo.state;
  const docs = [
    { title: 'LANTERN_KEEPER_pitch.docx - Word', context: 'LANTERN KEEPER pitch', h: 'LANTERN//KEEPER — publisher pitch', body: ['The hook: you play a lighthouse keeper who restores old lenses to rescue ships.', 'Every rescue leaves a lens behind, and that lens becomes the next level.', 'Need: the palette notes and the original design doc before Monday.'] },
    { title: 'Juniper & Rye sponsorship email - Gmail - Google Chrome', context: 'Juniper Rye sponsorship harvest market', h: 'Re: Juniper & Rye x Harvest Night Market', body: ['Hi, thanks for the overview. Can you send the stall layout and the activation budget?', 'We would want our name on the main stage between sets.'] },
    { title: 'level_design_brainstorm.txt - Notepad', context: 'level design tidal steps brainstorm', h: 'Level design brainstorm', body: ['What if levels are steps, not rooms?', 'Each step down costs something you carried.'] }
  ];
  let cur = -1, autoTimer = null;
  const $ = (id) => document.getElementById(id);
  function show(i, auto) {
    cur = i; const d = docs[i];
    S.title = d.title; S.context = d.context;
    $('doctitle').textContent = d.title;
    $('docbody').innerHTML = '<h1></h1>' + d.body.map(() => '<p></p>').join('') + '<p class="dim">Skitter reads the window title. Give him a few seconds and he may go looking on his own.</p>';
    $('docbody').querySelector('h1').textContent = d.h;
    $('docbody').querySelectorAll('p:not(.dim)').forEach((p, k) => { p.textContent = d.body[k]; });
    clearTimeout(autoTimer);
    if (auto) autoTimer = setTimeout(() => { if (window.__gofer.state() === 'idle') g.emit('auto-trip', {}); }, 3500);
  }
  function openFile(d) {
    S.title = d.name; $('doctitle').textContent = d.name + ' (opened by Skitter)';
    $('docbody').innerHTML = '<h1></h1><p></p><p class="dim"></p>';
    $('docbody').querySelector('h1').textContent = d.name;
    $('docbody').querySelector('p').textContent = d.text;
    $('docbody').querySelector('p.dim').textContent = d.dir;
  }
  $('btnSwitch').addEventListener('click', () => show((cur + 1) % docs.length, true));
  $('btnAsk').addEventListener('click', () => g.emit('ask', {}));
  g.on('open-doc', openFile);
  g.on('tally', (t) => {
    const n = t.accept + t.reveal + t.retry + t.ignore + t.dismiss;
    $('tally').textContent = n + (n === 1 ? ' fetch' : ' fetches') + ' · ' + (t.accept + t.reveal) + ' kept';
  });
  show(0, true);
})();
