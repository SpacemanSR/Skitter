/* Skitter renderer — the creature's state machine, animation and the preview card.
   Talks to the host through window.gofer (preload bridge in Electron, mock bridge in the web demo). */
(function () {
  'use strict';
  const bridge = window.gofer;
  const CR = window.Creature;
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);
  const el = { hello: $('hello'), ask: $('ask'), askInput: $('askInput'), status: $('status'), card: $('card'),
    cardIcon: $('cardIcon'), cardName: $('cardName'), cardMeta: $('cardMeta'), cardReason: $('cardReason'),
    cardSnippet: $('cardSnippet'), cardTerms: $('cardTerms'), cardTimer: $('cardTimer'),
    cardPreview: $('cardPreview'), cardImg: $('cardImg'), cardPreviewNote: $('cardPreviewNote'), cardRetry: $('cardRetry') };

  // ---------- state ----------
  const c = { x: 0, y: 0, rot: 0, facing: -1, pose: 'sit', walk: null, carrying: false, armRaise: 0, blink: 0,
    squash: 1, scale: 1, lookDir: 0, visible: true, inFolder: false, paperAngle: 0 };
  const f = { open: 0, shake: 0 };
  const puffs = [], scraps = [];
  let mode = 'idle';           // idle | ask | trip | present | happy
  let indexReady = false, docCount = 0, indexNote = '';
  let presentTimeoutSec = 14, eyelineFrac = 0.22, firstRun = false;
  let trip = null;             // current trip context
  let hover = false, interactive = false, dragging = null;
  const mouse = { x: -999, y: -999 };
  let lastDraw = 0, tStart = performance.now();

  // ---------- layout ----------
  function L() {
    const W = window.innerWidth, H = window.innerHeight;
    const groundY = H - 2;
    return { W, H, wallX: W - 2, standX: W - 26, perchY: Math.round(H * eyelineFrac), groundY,
      cornerY: groundY - 28, folderX: W - 96 };
  }
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr); canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px'; canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (mode === 'idle' || mode === 'ask') snapToPerch();
  }
  function snapToPerch() { const l = L(); c.x = l.standX; c.y = l.perchY; c.rot = 0; c.facing = -1; c.pose = 'sit'; c.walk = null; c.visible = true; c.inFolder = false; c.scale = 1; }
  window.addEventListener('resize', resize);

  // ---------- tiny tween engine ----------
  const tweens = new Set();
  const ease = { linear: (u) => u, inOut: (u) => u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2, out: (u) => 1 - Math.pow(1 - u, 3), in: (u) => u * u * u };
  function tween(obj, props, ms, fn) {
    return new Promise((resolve) => {
      const from = {}; for (const k in props) from[k] = obj[k];
      const t0 = performance.now(); const e = fn || ease.inOut;
      tweens.add({ step(now) { const u = Math.min(1, (now - t0) / ms); const v = e(u); for (const k in props) obj[k] = from[k] + (props[k] - from[k]) * v; if (u >= 1) { tweens.delete(this); resolve(); } } });
    });
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  function tick(now) { for (const t of Array.from(tweens)) t.step(now); }

  /* Walk the creature to a target along one axis at a speed (px/s), driving the walk cycle. */
  /* Walk to a target. `speed` is px/s, or pass {ms} to cover the distance in a fixed time (he runs when he has to). */
  function walkTo(target, speed, onStep) {
    return new Promise((resolve) => {
      const t0 = performance.now(); const x0 = c.x, y0 = c.y;
      const dx = (target.x == null ? 0 : target.x - x0), dy = (target.y == null ? 0 : target.y - y0);
      const dist = Math.hypot(dx, dy);
      const dur = typeof speed === 'object' ? Math.max(1, speed.ms) : Math.max(1, (dist / speed) * 1000);
      const v = dist / (dur / 1000);
      const stride = Math.min(26, 4 + v * 0.06);           // radians of walk cycle per second
      const lean = Math.max(0, Math.min(1, (v - 260) / 700)) * 0.22;
      let phase = 0, lastNow = t0, lastStep = 0;
      c.walk = 0; c.lean = lean;
      tweens.add({ step(now) {
        const u = Math.min(1, (now - t0) / dur); const e = u < 0.08 ? u * u / 0.16 : u > 0.92 ? 1 - (1 - u) * (1 - u) / 0.16 : u; // soft start/stop
        const k = Math.max(0, Math.min(1, e)); c.x = x0 + dx * k; c.y = y0 + dy * k;
        phase += (now - lastNow) / 1000 * stride; lastNow = now; c.walk = phase;
        if (onStep && Math.floor(phase / Math.PI) !== lastStep) { lastStep = Math.floor(phase / Math.PI); onStep(); }
        if (u >= 1) { tweens.delete(this); c.walk = null; c.lean = 0; resolve(); }
      } });
    });
  }
  /* Hop off the rim and fall to the ground with squash + bounce. */
  function hopAndFall(toX, groundY) {
    return new Promise((resolve) => {
      let vx = (toX - c.x) / 0.45, vy = -160, last = performance.now(), bounces = 0;
      c.walk = null; c.pose = 'walk';
      tweens.add({ step(now) {
        const dt = Math.min(0.04, (now - last) / 1000); last = now;
        vy += 1500 * dt; c.x += vx * dt; c.y += vy * dt;
        c.squash = vy < -40 ? 1.08 : vy > 300 ? 1.1 : 1;
        if (c.y >= groundY) {
          c.y = groundY;
          if (vy > 260 && bounces < 2) { vy = -vy * 0.32; bounces++; vx *= 0.5; thud(0.7); }
          else { vx = 0; vy = 0; thud(1); tweens.delete(this); landSquash().then(resolve); }
        }
      } });
    });
  }
  async function landSquash() { c.squash = 0.62; await tween(c, { squash: 1.06 }, 140, ease.out); await tween(c, { squash: 1 }, 120, ease.inOut); }
  function thud(k) { const l = L(); for (let i = 0; i < 5; i++) puffs.push({ x: c.x + (Math.random() - 0.5) * 24, y: l.groundY - 2, r: 3 + Math.random() * 4 * k, vx: (Math.random() - 0.5) * 60, vy: -20 - Math.random() * 30, life: 1 }); }
  function stepPuff() { const l = L(); puffs.push({ x: c.x - c.facing * 6, y: l.groundY - 1, r: 2.5 + Math.random() * 2, vx: -c.facing * 20, vy: -15, life: 0.7 }); }

  // ---------- blinking / looking ----------
  async function blinkLoop() { while (true) { await wait(2500 + Math.random() * 3500); if (mode === 'idle' || mode === 'present') { await tween(c, { blink: 1 }, 70); await tween(c, { blink: 0 }, 90); } } }
  blinkLoop();

  // ---------- the trip ----------
  /* Time budgets per leg (ms). The search starts before he moves; the walk delivers it. */
  const PACE = {
    brisk:  { toWall: 200, swing: 150, down: 800, corner: 160, toFolder: 300, open: 120, enter: 260, rummage: 380, climb: 340, back: 300, up: 950, perch: 180 },
    stroll: { toWall: 480, swing: 250, down: 2000, corner: 260, toFolder: 760, open: 210, enter: 480, rummage: 1000, climb: 640, back: 760, up: 2300, perch: 270 }
  };
  let tripPace = 'brisk';
  async function runTrip(tripMode, task, excludes, fast) {
    if (mode !== 'idle' && mode !== 'present') return;
    hideCard(false);
    trip = { mode: tripMode, task, excludes: excludes || [], fast: !!fast, id: Date.now() };
    mode = 'trip';
    const l = L();
    const P = Object.assign({}, PACE[tripPace] || PACE.brisk);
    if (fast) for (const k in P) P[k] = Math.round(P[k] * 0.8);
    const fetchP = bridge.fetch({ mode: tripMode, task: task || null, exclude: trip.excludes }).catch((e) => ({ found: false, error: String(e) }));

    // leave the perch: walk to the wall, swing onto it
    c.pose = 'walk'; c.facing = 1; c.carrying = false; c.armRaise = 0;
    await walkTo({ x: l.wallX - 8 }, { ms: P.toWall });
    await tween(c, { rot: -Math.PI / 2, x: l.wallX, y: l.perchY + 14 }, P.swing);
    c.facing = -1;
    // down the edge
    await walkTo({ y: l.cornerY }, { ms: P.down });
    await tween(c, { rot: 0, x: l.standX, y: l.groundY }, P.corner);
    c.facing = -1;
    await walkTo({ x: l.folderX + 46 }, { ms: P.toFolder }, stepPuff);
    // into the folder
    await tween(f, { open: 1 }, P.open);
    c.inFolder = true;
    await Promise.all([walkTo({ x: l.folderX + 4, y: l.groundY - 8 }, { ms: P.enter }), tween(c, { scale: 0.82 }, P.enter)]);
    c.visible = false;
    await tween(f, { open: 0.25 }, 120);
    // rummage for as long as the search really takes, with a short floor so it reads as work
    const t0 = performance.now(); f.shake = 1;
    const scrapTimer = setInterval(() => { if (scraps.length < 7) scraps.push({ x: l.folderX + (Math.random() - 0.5) * 30, y: l.groundY - 50, vx: (Math.random() - 0.5) * 90, vy: -140 - Math.random() * 120, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 8, alpha: 1 }); }, 200);
    const res = await fetchP;
    const left = P.rummage - (performance.now() - t0); if (left > 0) await wait(left);
    clearInterval(scrapTimer); f.shake = 0;
    // climb out onto the rim
    await tween(f, { open: 1 }, 120);
    c.visible = true; c.inFolder = true; c.x = l.folderX; c.y = l.groundY - 6; c.scale = 0.82; c.rot = 0; c.facing = 1; c.pose = 'walk';
    c.carrying = !!res.found; c.armRaise = res.found ? 1 : 0;
    const previewP = res.found && bridge.preview ? bridge.preview(res.proposal.id).catch(() => null) : Promise.resolve(null);
    await Promise.all([walkTo({ y: l.groundY - 52 }, { ms: P.climb }), tween(c, { scale: 1 }, P.climb)]);
    c.inFolder = false;
    // fall to the ground
    await hopAndFall(l.folderX + 46, l.groundY);
    tween(f, { open: 0 }, 220);
    // back along the ground and up the edge
    c.pose = 'walk'; c.facing = 1;
    await walkTo({ x: l.standX }, { ms: P.back }, stepPuff);
    await tween(c, { rot: -Math.PI / 2, x: l.wallX, y: l.cornerY }, P.corner);
    c.facing = 1;
    await walkTo({ y: l.perchY + 14 }, { ms: P.up });
    await tween(c, { rot: 0, x: l.standX, y: l.perchY }, P.perch);
    c.facing = -1;
    if (res.found) {
      mode = 'present'; c.pose = 'idle';
      trip.proposal = res.proposal; trip.alternativesLeft = res.alternativesLeft; trip.previewP = previewP;
      await tween(c, { paperAngle: -0.35 }, 220);
      showCard(res.proposal, res.proposal.reason || res.reason, previewP);
    } else {
      c.pose = 'shrug'; c.carrying = false; c.armRaise = 0;
      showStatus(res.error ? 'Something went wrong. Check the log.' : (tripMode === 'task' ? "Couldn't find it. Right-click me if I missed one." : 'Nothing worth bringing back.'), 4200);
      await wait(2200);
      c.pose = 'sit'; mode = 'idle'; trip = null;
    }
    syncInteractive();
  }

  // ---------- card ----------
  let cardTimer = null, cardShownAt = 0, cardRemaining = 0, hideTimer = null;
  function timeAgo(ms) { const d = (Date.now() - ms) / 1000; if (d < 90) return 'just now'; if (d < 3600) return Math.round(d / 60) + 'm ago'; if (d < 86400 * 2) return Math.round(d / 3600) + 'h ago'; if (d < 86400 * 60) return Math.round(d / 86400) + 'd ago'; return Math.round(d / 86400 / 30) + 'mo ago'; }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
  function showPreview(previewP, forId) {
    const box = el.cardPreview, img = el.cardImg;
    img.classList.remove('loaded'); img.removeAttribute('src'); el.cardPreviewNote.classList.add('hidden');
    box.classList.remove('hidden', 'page'); box.classList.add('loading'); el.card.classList.add('has-preview');
    const giveUp = () => { box.classList.add('hidden'); box.classList.remove('loading'); el.card.classList.remove('has-preview', 'wide'); };
    Promise.race([previewP, wait(9000).then(() => null)]).then((pv) => {
      if (!trip || !trip.proposal || trip.proposal.id !== forId) return;
      if (!pv || !pv.dataUrl) { if (pv && pv.note) { box.classList.remove('loading'); img.removeAttribute('src'); el.cardPreviewNote.textContent = pv.note; el.cardPreviewNote.classList.remove('hidden'); box.style.height = '44px'; } else giveUp(); return; }
      box.style.height = '';
      box.classList.toggle('page', pv.kind === 'page' || pv.kind === 'cover');
      img.onload = () => { box.classList.remove('loading'); img.classList.add('loaded'); };
      img.onerror = giveUp;
      img.src = pv.dataUrl;
    });
  }
  function showCard(p, reason, previewP) {
    const l = L();
    el.card.classList.remove('wide'); el.cardPreview.style.height = '';
    if (previewP) showPreview(previewP, p.id); else { el.cardPreview.classList.add('hidden'); el.card.classList.remove('has-preview'); }
    el.cardIcon.textContent = (p.ext || 'file').replace('.', '').toUpperCase().slice(0, 4);
    el.cardName.textContent = p.name; el.cardName.title = p.path;
    el.cardMeta.textContent = (p.dirLabel || p.dir || '') + ' · ' + (p.mtime ? timeAgo(p.mtime) : '');
    if (reason) { el.cardReason.textContent = reason; el.cardReason.classList.remove('hidden'); } else el.cardReason.classList.add('hidden');
    // snippet with highlights
    let html = escapeHtml(p.snippet || '');
    if (p.matched && p.matched.length) {
      const words = p.matched.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter((w) => w.length > 1).sort((a, b) => b.length - a.length);
      if (words.length) html = html.replace(new RegExp('(^|[^\\w])(' + words.join('|') + ')(\\w*)', 'gi'), (m, pre, w, rest) => pre + '<mark>' + w + rest + '</mark>');
    }
    el.cardSnippet.innerHTML = html; el.cardSnippet.classList.toggle('hidden', !html);
    el.cardTerms.innerHTML = (p.matched || []).slice(0, 7).map((w) => '<span>' + escapeHtml(w) + '</span>').join('');
    clearTimeout(hideTimer);
    el.card.classList.remove('hidden', 'out', 'fly', 'counting', 'paused');
    positionCard();
    requestAnimationFrame(() => { el.card.classList.add('in'); startCardTimer(presentTimeoutSec * 1000); });
  }
  function positionCard() {
    const l = L(); const w = el.card.offsetWidth, h = el.card.offsetHeight;
    const right = l.standX - 44; const cy = c.y - 44;
    el.card.style.left = Math.max(8, right - w) + 'px';
    el.card.style.top = Math.max(8, Math.min(l.H - h - 8, cy - h / 2)) + 'px';
  }
  function startCardTimer(ms) {
    cardRemaining = ms; cardShownAt = performance.now();
    el.card.style.setProperty('--present-ms', ms + 'ms');
    el.card.classList.remove('paused'); void el.card.offsetWidth; el.card.classList.add('counting');
    clearTimeout(cardTimer); cardTimer = setTimeout(() => decide('ignore'), ms);
  }
  function pauseCardTimer() { if (!cardTimer) return; clearTimeout(cardTimer); cardTimer = null; cardRemaining -= performance.now() - cardShownAt;
    const sx = Math.max(0, cardRemaining / (presentTimeoutSec * 1000)); el.card.classList.remove('counting'); el.card.classList.add('paused'); el.cardTimer.style.transform = 'scaleX(' + sx + ')'; }
  function resumeCardTimer() { if (cardTimer || mode !== 'present') return; el.cardTimer.style.transform = ''; startCardTimer(Math.max(3000, cardRemaining)); }
  function hideCard(fly) { clearTimeout(cardTimer); cardTimer = null; if (el.card.classList.contains('hidden')) return; el.card.classList.remove('in', 'counting', 'paused'); el.card.classList.add(fly ? 'fly' : 'out'); clearTimeout(hideTimer); hideTimer = setTimeout(() => { el.card.classList.add('hidden'); syncInteractive(); }, 560); }

  async function decide(outcome) {
    if (mode !== 'present' || !trip) return;
    const p = trip.proposal; const tripMode = trip.mode, task = trip.task, excludes = trip.excludes.concat([p.path]);
    bridge.decide({ id: p.id, outcome });
    if (outcome === 'accept' || outcome === 'reveal') {
      hideCard(true); mode = 'happy'; c.carrying = false; c.armRaise = 0; c.pose = 'happy';
      await wait(1100); if (mode === 'happy') { c.pose = 'sit'; mode = 'idle'; trip = null; }
    } else if (outcome === 'retry') {
      hideCard(false); c.pose = 'walk'; await tween(c, { armRaise: 0, paperAngle: 0 }, 220); c.carrying = false;
      mode = 'idle'; runTrip(tripMode, task, excludes, true);
    } else { // ignore / dismiss
      hideCard(false); await tween(c, { armRaise: 0, paperAngle: 0 }, 300); c.carrying = false; c.pose = 'sit'; mode = 'idle'; trip = null;
    }
    syncInteractive();
  }
  // Open on press-and-release inside the card rather than the 'click' event: on Windows the card can move
  // a pixel or lose the press to its own fade-in, and then 'click' never fires.
  let cardPress = false;
  el.card.addEventListener('mousedown', (e) => { if (e.button === 0) { cardPress = true; if (bridge.click) bridge.click({ on: 'card', mode }); } });
  el.card.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || !cardPress) return; cardPress = false; e.stopPropagation();
    if (el.cardRetry.contains(e.target)) decide('retry'); else decide('accept');
  });
  el.card.addEventListener('click', (e) => e.stopPropagation());
  el.card.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); decide('reveal'); });
  el.card.addEventListener('mouseenter', pauseCardTimer);
  // hover the picture to open the card wide; click the picture (or anywhere on the card) to open the file
  el.cardPreview.addEventListener('mouseenter', () => { if (!el.cardPreview.classList.contains('hidden') && el.cardImg.getAttribute('src')) el.card.classList.add('wide'); });
  // Once wide it stays wide until you decide: shrinking it on the way out moved "click to open" out from
  // under the pointer, so the click landed on empty screen.
  el.card.addEventListener('mouseleave', resumeCardTimer);

  // ---------- ask bubble ----------
  function openAsk() {
    mode = 'ask'; c.pose = 'idle'; c.lookDir = -1;
    const l = L(); el.ask.classList.remove('hidden');
    el.ask.style.left = (l.standX - 52 - 280) + 'px'; el.ask.style.top = (c.y - 70) + 'px';
    bridge.focus(true); el.askInput.value = ''; setTimeout(() => el.askInput.focus(), 30);
    // Windows sometimes refuses the first request for the keyboard (right after another app opened); ask again.
    setTimeout(() => { if (mode === 'ask' && !document.hasFocus()) { bridge.focus(true); setTimeout(() => el.askInput.focus(), 60); } }, 250);
  }
  function closeAsk() { el.ask.classList.add('hidden'); bridge.focus(false); if (mode === 'ask') { mode = 'idle'; c.pose = 'sit'; } syncInteractive(); }
  el.askInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeAsk(); }
    else if (e.key === 'Enter') { e.preventDefault(); const q = el.askInput.value.trim(); closeAsk(); if (q) runTrip('task', q, [], false); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mode === 'present') decide('dismiss'); });

  // ---------- status pill / hello ----------
  let statusTimer = null;
  function showStatus(text, ms) { const l = L(); el.status.textContent = text; el.status.classList.remove('hidden');
    el.status.style.left = Math.max(8, l.standX - 60 - el.status.offsetWidth) + 'px'; el.status.style.top = (c.y - 54) + 'px';
    clearTimeout(statusTimer); if (ms) statusTimer = setTimeout(() => el.status.classList.add('hidden'), ms); }
  function hideStatus() { clearTimeout(statusTimer); el.status.classList.add('hidden'); }
  function showHello() { const l = L(); el.hello.classList.remove('hidden'); el.hello.style.left = (l.standX - 52 - 280) + 'px'; el.hello.style.top = (l.perchY - 74) + 'px'; setTimeout(() => el.hello.classList.add('hidden'), 9000); }

  // ---------- pointer / click-through ----------
  function bodyCenter() { return { x: c.x + 26 * Math.sin(c.rot), y: c.y - 26 * Math.cos(c.rot) }; }
  function overCreature(x, y) { if (!c.visible) return false; const b = bodyCenter(); return Math.hypot(x - b.x, y - b.y) < 34; }
  function overDom(x, y) { const e = document.elementFromPoint(x, y); return !!(e && e !== document.body && e !== canvas && e !== document.documentElement); }
  /* Where Skitter and his UI are, so the host can catch clicks there even if Windows never forwards mouse moves to us. */
  let lastZones = '', lastZonesAt = 0;
  function reportZones(now) {
    if (!bridge.hitZones || now - lastZonesAt < 80) return;
    const z = [];
    if (c.visible) { const b = bodyCenter(); z.push([Math.round(b.x - 36), Math.round(b.y - 36), 72, 72]); }
    for (const e of [el.card, el.ask]) if (!e.classList.contains('hidden')) { const r = e.getBoundingClientRect(); if (r.width) z.push([Math.round(r.left) - 6, Math.round(r.top) - 6, Math.round(r.width) + 12, Math.round(r.height) + 12]); }
    const key = JSON.stringify(z);
    if (key !== lastZones) { lastZones = key; lastZonesAt = now; bridge.hitZones(z); }
  }
  function syncInteractive() {
    const want = hover || overDom(mouse.x, mouse.y) || mode === 'ask' || !!dragging;
    if (want !== interactive) { interactive = want; bridge.setInteractive(want); }
    canvas.classList.toggle('hand', hover && !dragging); canvas.classList.toggle('grab', !!dragging);
  }
  window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX; mouse.y = e.clientY;
    hover = overCreature(e.clientX, e.clientY);
    if (dragging && !dragging.fixed) { if (!dragging.moved && Math.abs(e.clientY - dragging.y0) > 4) dragging.moved = true;
      if (dragging.moved) { const l = L(); eyelineFrac = Math.min(0.9, Math.max(0.06, e.clientY / l.H)); snapToPerch(); } }
    syncInteractive();
  });
  window.addEventListener('mouseleave', () => { hover = false; mouse.x = mouse.y = -999; syncInteractive(); });
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (!overCreature(e.clientX, e.clientY)) return;
    if (bridge.click) bridge.click({ on: 'him', mode, x: e.clientX, y: e.clientY, focused: document.hasFocus() });
    if (mode === 'happy') { mode = 'idle'; c.pose = 'sit'; trip = null; } // don't make him wait out his little celebration
    if (mode === 'idle' || mode === 'present') dragging = { y0: e.clientY, moved: false, fixed: mode !== 'idle' };
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    if (dragging) {
      const d = dragging; dragging = null;
      if (d.moved) bridge.saveUi({ eyelineFrac });
      else if (mode === 'idle') openAsk();
      // Clicking him always means "I have a new job for you": the card steps aside (a soft no) and the box opens.
      else if (mode === 'present') decide('ignore').then(() => { if (mode === 'idle') openAsk(); });
      syncInteractive(); return;
    }
    cardPress = false;
    if (mode === 'ask' && !overCreature(e.clientX, e.clientY) && !overDom(e.clientX, e.clientY)) closeAsk();
  });
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); if (overCreature(e.clientX, e.clientY)) bridge.menu({ x: e.clientX, y: e.clientY }); });

  // ---------- host events ----------
  bridge.on('index-progress', (p) => {
    const was = indexReady; indexReady = !!p.ready; docCount = p.count || 0; indexNote = p.note || '';
    if (!indexReady) { if (mode === 'idle') c.pose = 'read'; showStatus('Reading your folders… ' + docCount.toLocaleString() + ' files', 0); }
    else if (!was) { if (mode === 'idle') c.pose = 'sit'; showStatus('Ready · ' + docCount.toLocaleString() + ' files indexed', 2600); }
  });
  bridge.on('status', (m) => { if (m && m.text) showStatus(m.text, 6000); });
  bridge.on('auto-trip', () => { if (mode === 'idle' && !dragging) runTrip('auto', null, [], false); });
  bridge.on('resize', () => resize());
  bridge.on('ask', () => { if (mode === 'idle' && !dragging) openAsk(); });
  let lastSentMode = null;
  setInterval(() => { if (mode !== lastSentMode) { lastSentMode = mode; if (bridge.mode) bridge.mode(mode); } }, 400);
  bridge.on('settings', (s) => { if (s.tripPace) tripPace = s.tripPace; if (s.presentTimeoutSec) presentTimeoutSec = s.presentTimeoutSec; if (s.eyelineFrac) { eyelineFrac = s.eyelineFrac; if (mode === 'idle') snapToPerch(); } });

  // ---------- drawing ----------
  function drawPerch(l) {
    ctx.save();
    ctx.fillStyle = '#8a6a44'; ctx.strokeStyle = '#4a2d18'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(l.W - 50, l.perchY, 54, 7, [3, 0, 0, 3]); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(l.W - 44, l.perchY + 7); ctx.lineTo(l.W - 2, l.perchY + 26); ctx.lineTo(l.W - 2, l.perchY + 7); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  function drawCreature(t) {
    ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.rot + (c.lean || 0) * c.facing); ctx.scale(c.scale, c.scale);
    CR.drawGopher(ctx, { facing: c.facing, walk: c.walk, carrying: c.carrying, armRaise: c.armRaise, blink: c.blink, pose: c.pose, squash: c.squash, lookDir: c.lookDir, paperAngle: c.paperAngle, t });
    ctx.restore();
  }
  function frame(now) {
    requestAnimationFrame(frame);
    tick(now);
    const idle = (mode === 'idle' || mode === 'ask') && tweens.size === 0 && puffs.length === 0 && scraps.length === 0;
    if (idle && now - lastDraw < 50) return; // ~20 fps when nothing moves
    const dt = Math.min(0.05, (now - lastDraw) / 1000) || 0.016; lastDraw = now;
    const t = (now - tStart) / 1000; const l = L();
    // look at the cursor when idle
    if (mode === 'idle' || mode === 'present') { const b = bodyCenter(); const target = mouse.x < 0 ? 0 : Math.max(-1, Math.min(1, (mouse.x - b.x) / 240)) * c.facing; c.lookDir += (target - c.lookDir) * 0.15; }
    ctx.clearRect(0, 0, l.W, l.H);
    // particles
    for (let i = puffs.length - 1; i >= 0; i--) { const p = puffs[i]; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 40 * dt; p.life -= dt * 1.4; p.r += 8 * dt; if (p.life <= 0) puffs.splice(i, 1); else CR.drawPuff(ctx, p.x, p.y, p.r, p.life * 0.6); }
    drawPerch(l);
    // folder + creature with correct occlusion
    ctx.save(); ctx.translate(l.folderX, l.groundY); CR.drawFolder(ctx, f); ctx.restore();
    if (c.visible && c.inFolder) drawCreature(t);
    ctx.save(); ctx.translate(l.folderX, l.groundY); CR.drawFolderFront(ctx, f); ctx.restore();
    if (c.visible && !c.inFolder) { if (c.rot === 0 && c.y > l.groundY - 1) CR.drawShadow(ctx, c.x, l.groundY + 1, 18 * c.scale); drawCreature(t); }
    for (let i = scraps.length - 1; i >= 0; i--) { const s = scraps[i]; s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 420 * dt; s.rot += s.vr * dt; if (s.y > l.groundY - 40) s.alpha -= dt * 4; if (s.alpha <= 0) scraps.splice(i, 1); else CR.drawScrap(ctx, s); }
    if (mode === 'present' && !el.card.classList.contains('hidden')) positionCard();
    reportZones(now);
    if (!el.status.classList.contains('hidden') && !indexReady) { el.status.style.left = Math.max(8, l.standX - 60 - el.status.offsetWidth) + 'px'; el.status.style.top = (c.y - 54) + 'px'; }
  }

  // ---------- boot ----------
  (async function boot() {
    resize();
    try {
      const s = await bridge.getState();
      indexReady = !!s.ready; docCount = s.count || 0; presentTimeoutSec = s.presentTimeoutSec || 14; tripPace = s.tripPace || 'brisk'; eyelineFrac = s.eyelineFrac || 0.22; firstRun = !!s.firstRun;
    } catch (e) { /* mock bridges may not implement everything */ }
    snapToPerch();
    if (!indexReady) { c.pose = 'read'; showStatus('Reading your folders…', 0); }
    if (firstRun) showHello();
    requestAnimationFrame(frame);
  })();

  // expose a little for the demo page
  window.__gofer = { runTrip, state: () => mode };
})();
