'use strict';
/* Skitter — main process. Owns the overlay window, tray, context sensors and the human-readable log.
   All indexing, search, embeddings and learning live in the engine process (engine/worker.js). */
const { app, BrowserWindow, screen, ipcMain, Tray, Menu, clipboard, shell, dialog, nativeImage, utilityProcess, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

const { Settings } = require('./settings');
const { Log } = require('./log');
const { Context } = require('./context');

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.setAppUserModelId('com.mrinteractive.skitter');
if (process.env.GOFER_USERDATA) app.setPath('userData', process.env.GOFER_USERDATA); // isolated runs (tests, CI)
const IS_STORE = !!process.windowsStore;   // Microsoft Store build: the Store handles updates and start-up
let update = { state: 'idle', version: null };
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let win = null, tray = null;
let settings, log, context, engine;
let interactive = false, rendererMode = 'idle';
let engineStats = { count: 0, ready: false, scanning: false, chunks: 0, embeddedChunks: 0, semantic: 'loading', ranker: {}, summary: { total: 0, kept: 0, rate: 0 } };
let current = { title: '', path: null };        // the file the foreground window is showing, when we can tell
let pendingAuto = null, lastAutoKey = '', lastAutoAt = 0, autoBusy = false;
let lastRequest = null;                          // the last thing you asked for (for "he missed one")
const proposalPaths = new Map();                 // proposal id -> path (renderer only hands back the id)

const userFile = (name) => path.join(app.getPath('userData'), name);

/* The model ships inside the app (verified at build time against model.lock.json). Dev runs fall back to a downloaded copy. */
function modelDir() {
  if (process.env.GOFER_MODEL_DIR) return process.env.GOFER_MODEL_DIR;
  const bundled = path.join(__dirname, '..', 'model');
  if (fs.existsSync(path.join(bundled, 'model_quantized.onnx'))) return bundled;
  return userFile(path.join('models', 'all-MiniLM-L6-v2'));
}

/* Updates for direct-download installs: GitHub Releases, downloaded quietly, installed when you quit or click Restart. */
function setupUpdates() {
  if (!app.isPackaged || IS_STORE || process.platform !== 'win32' || process.env.GOFER_SMOKE) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { log.debug('updater unavailable', e.message); return; }
  autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m) => log.debug('[update]', String(m)), warn: (m) => log.debug('[update]', String(m)), error: (m) => log.debug('[update] error', String(m)), debug: () => {} };
  autoUpdater.on('update-available', (i) => { update = { state: 'downloading', version: i.version }; });
  autoUpdater.on('update-downloaded', (i) => { update = { state: 'ready', version: i.version }; showStatus('Update ' + i.version + ' is ready. Right-click me to restart.'); });
  autoUpdater.on('error', (e) => { update = { state: 'idle', version: null }; log.debug('[update] failed', e.message); });
  const check = () => autoUpdater.checkForUpdates().catch((e) => log.debug('[update] check failed', e.message));
  setTimeout(check, 60 * 1000); setInterval(check, 6 * 3600 * 1000);
  setupUpdates.install = () => autoUpdater.quitAndInstall(false, true);
}
function showStatus(text) { send('status', { text }); }

// ---------- engine process (RPC) ----------
class EngineClient {
  constructor() { this.seq = 0; this.pending = new Map(); this.child = null; this.restarts = 0; }
  start(initArgs) {
    this.initArgs = initArgs;
    this.child = utilityProcess.fork(path.join(__dirname, 'engine', 'worker.js'), [], { serviceName: 'Skitter Engine', stdio: 'pipe' });
    this.child.stdout && this.child.stdout.on('data', (d) => log.debug('[engine:stdout]', d.toString().trim()));
    this.child.stderr && this.child.stderr.on('data', (d) => { const s = d.toString().trim(); if (s && !/ExperimentalWarning|trace-warnings/.test(s)) log.debug('[engine:stderr]', s); });
    this.child.on('message', (m) => {
      if (m && m.event) {
        if (m.event === 'log') log.debug('[engine]', m.data);
        else if (m.event === 'progress') { engineStats = Object.assign(engineStats, m.data); send('index-progress', m.data); }
        return;
      }
      const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
    });
    this.child.on('exit', (code) => {
      log.debug('engine exited', code);
      for (const p of this.pending.values()) p.reject(new Error('engine stopped')); this.pending.clear();
      this.child = null;
      if (!app.isQuitting && this.restarts++ < 5) setTimeout(() => this.start(this.initArgs), 2000);
    });
    return this.call('init', initArgs);
  }
  call(cmd, args, timeoutMs) {
    if (!this.child) return Promise.reject(new Error('engine not running'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { if (this.pending.delete(id)) reject(new Error('engine timeout: ' + cmd)); }, timeoutMs || 30000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.child.postMessage({ id, cmd, args });
    });
  }
}

// ---------- overlay window ----------
function targetDisplay() {
  const all = screen.getAllDisplays(); const id = settings.get('displayId');
  return all.find((d) => d.id === id) || screen.getPrimaryDisplay();
}
function createOverlay() {
  const wa = targetDisplay().workArea;
  win = new BrowserWindow({
    x: wa.x, y: wa.y, width: wa.width, height: wa.height,
    transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, focusable: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    hasShadow: false, show: false, title: 'Skitter', backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false }
  });
  win.setMenu(null);
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: !process.env.GOFER_NO_FORWARD });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { win.showInactive(); if (process.env.GOFER_DEBUG) win.webContents.openDevTools({ mode: 'detach' }); });
  win.on('closed', () => { win = null; });
  win.webContents.on('console-message', (ev) => { if (ev.level === 'error' || ev.level === 'warning' || process.env.GOFER_DEBUG) log.debug('[renderer]', ev.level, ev.message); });
  win.webContents.on('render-process-gone', (_e, d) => log.debug('renderer gone', d.reason));
  if (process.env.GOFER_SMOKE) win.webContents.once('did-finish-load', () => smokeTest());
}
function relayout() {
  if (!win) return;
  const a = targetDisplay().workArea;
  win.setBounds({ x: a.x, y: a.y, width: a.width, height: a.height });
  send('resize', a);
}
function moveToCursorDisplay() {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  settings.set('displayId', d.id); relayout();
}
function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send('gofer:' + channel, data); }

// ---------- tray + menu ----------
function trayIcon() { try { const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png')); if (!img.isEmpty()) return img; } catch (e) {} return nativeImage.createEmpty(); }
function pct(x) { return Math.round((x || 0) * 100) + '%'; }
function buildMenu() {
  const s = engineStats, sum = s.summary || {};
  const meaning = s.semantic === 'on' ? (s.chunks ? 'Meaning search: ' + pct(s.embeddedChunks / s.chunks) + ' of passages ready' : 'Meaning search: on')
    : s.semantic === 'off' ? 'Meaning search: off' : s.semantic === 'loading' ? 'Meaning search: getting ready…' : 'Meaning search unavailable (offline?)';
  const auto = sum.byMode && sum.byMode.auto ? sum.byMode.auto : null;
  const multi = screen.getAllDisplays().length > 1;
  return Menu.buildFromTemplate([
    { label: live.on ? 'End live session (' + liveSummary() + ')' : 'Start live session', accelerator: 'CommandOrControl+Alt+L', click: () => setLive(!live.on) },
    { type: 'separator' },
    { label: 'Fetch something…', click: () => send('ask', {}) },
    { type: 'separator' },
    { label: 'Go looking on his own', type: 'checkbox', checked: !!settings.get('autoMode'), click: (i) => settings.set('autoMode', i.checked) },
    { label: 'Search by meaning', type: 'checkbox', checked: !!settings.get('semantic'), click: (i) => { settings.set('semantic', i.checked); engine.call('setSemantic', { on: i.checked }).catch(() => {}); } },
    { label: 'Pace', submenu: [
      { label: 'Brisk (~5 s trips)', type: 'radio', checked: settings.get('tripPace') !== 'stroll', click: () => { settings.set('tripPace', 'brisk'); pushSettings(); } },
      { label: 'Stroll (~9 s trips)', type: 'radio', checked: settings.get('tripPace') === 'stroll', click: () => { settings.set('tripPace', 'stroll'); pushSettings(); } }] },
    ...(multi ? [{ label: 'Move Skitter to the screen with the mouse', click: moveToCursorDisplay }] : []),
    { type: 'separator' },
    { label: (s.scanning ? 'Reading folders… ' : '') + (s.count || 0).toLocaleString() + ' files indexed', enabled: false },
    { label: meaning, enabled: false },
    { label: sum.total ? 'Kept ' + pct(sum.rate) + ' of ' + sum.total + ' fetches' + (auto ? ' · unassigned ' + pct(auto.kept / auto.total) : '') : 'No fetches yet', enabled: false },
    { label: 'Context: ' + ({ events: 'live', polling: 'basic (titles only)', none: 'off' }[context.mode()] || context.mode()), enabled: false },
    // Store builds register a Windows startup task instead (toggle it in Task Manager › Startup apps)
    { label: 'Start with Windows', type: 'checkbox', visible: process.platform === 'win32' && !IS_STORE, checked: process.platform === 'win32' && !IS_STORE && app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { label: 'He missed a file. Show him which…', click: showMissedFile },
    { label: 'Choose folders…', click: chooseFolders },
    { label: 'Rebuild index', click: () => engine.call('rescan', { full: true }).catch(() => {}) },
    { label: 'Open data folder', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    ...(update.state === 'ready' ? [{ label: 'Restart to update to ' + update.version, click: () => setupUpdates.install && setupUpdates.install() }] : []),
    { label: 'Skitter ' + app.getVersion() + (update.state === 'downloading' ? ' (downloading ' + update.version + '…)' : ''), enabled: false },
    { label: 'Quit Skitter', click: () => app.quit() }
  ]);
}
async function refreshStats() { try { engineStats = Object.assign(engineStats, await engine.call('stats', {}, 5000)); } catch (e) {} }
function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Skitter: click to fetch, right-click for options');
  tray.on('click', () => send('ask', {}));
  tray.on('right-click', async () => { await refreshStats(); tray.popUpContextMenu(buildMenu()); });
}
/* You point at the file you wanted; he explains why he didn't bring it, fixes what he can, and learns. */
async function showMissedFile() {
  const pick = await dialog.showOpenDialog({ title: lastRequest && lastRequest.task ? 'Which file did you want for \u201c' + lastRequest.task + '\u201d?' : 'Which file should Skitter have found?',
    properties: ['openFile'], defaultPath: app.getPath('documents') });
  if (pick.canceled || !pick.filePaths.length) return;
  let res;
  try { res = await engine.call('diagnose', { path: pick.filePaths[0], request: lastRequest }, 60000); }
  catch (e) { dialog.showMessageBox({ type: 'error', message: 'Skitter couldn\u2019t check that file.', detail: e.message }); return; }
  log.debug('missed file', pick.filePaths[0], '→', res.verdict, res.rank || '');
  if (res.verdict === 'outside') {
    const r = await dialog.showMessageBox({ type: 'question', message: res.message, buttons: ['Add that folder', 'Not now'], defaultId: 0, cancelId: 1 });
    if (r.response === 0) { const roots = settings.get('roots').concat([res.folder]); settings.set('roots', roots); engine.call('setRoots', { roots }).catch(() => {}); showStatus('Reading ' + path.basename(res.folder) + '…'); }
  } else dialog.showMessageBox({ type: 'info', message: res.message });
}

async function chooseFolders() {
  const res = await dialog.showOpenDialog({ title: 'Folders Skitter may dig through (these replace the current list: ' + settings.get('roots').map((r) => path.basename(r)).join(', ') + ')', properties: ['openDirectory', 'multiSelections'], defaultPath: app.getPath('documents') });
  if (res.canceled || !res.filePaths.length) return;
  settings.set('roots', res.filePaths);
  engine.call('setRoots', { roots: res.filePaths }).catch(() => {});
}
function pushSettings() { send('settings', { presentTimeoutSec: settings.get('presentTimeoutSec'), eyelineFrac: settings.get('eyelineFrac'), tripPace: settings.get('tripPace') }); }

// ---------- context → engine ----------
async function onForeground(fg) {
  current = { title: fg.title, path: null };
  try {
    const p = await engine.call('resolveFile', { title: fg.title, recent: context.recent }, 5000);
    if (current.title === fg.title) { current.path = p || null; if (p) engine.call('opened', { path: p, ts: Date.now(), src: 'focus' }).catch(() => {}); }
    log.debug('[fg]', fg.process, '|', fg.clean, p ? '→ ' + p : '');
  } catch (e) { /* engine busy or restarting */ }
}
function searchRequest(mode, extra) {
  const snap = context.snapshot();
  return Object.assign({ mode, title: snap.title, cleanTitle: snap.cleanTitle, focusedText: snap.focusedText, clip: snap.clip,
    currentPath: current.title === snap.title ? current.path : null }, extra || {});
}

// ---------- unassigned trips: the search happens first, the walk only delivers it ----------
async function autoCheck() {
  if (live.on) return; // the live session does its own, faster checks
  if (!win || autoBusy || !settings.get('autoMode') || !engineStats.ready || rendererMode !== 'idle') return;
  const snap = context.snapshot();
  if (!snap.cleanTitle && !current.path) return;
  if (Date.now() - snap.titleSince < settings.get('autoSettleSec') * 1000) return;
  const key = snap.title + '|' + (snap.focusedText || '').slice(-200);
  if (key === lastAutoKey) return;
  if (Date.now() - lastAutoAt < settings.get('autoCooldownMin') * 60000) return;
  lastAutoKey = key; autoBusy = true;
  try {
    if (!snap.focusedText) await context.refreshFocusedText();
    const res = await engine.call('search', searchRequest('auto'), 15000);
    if (res && res.found) {
      pendingAuto = { res, at: Date.now() }; lastAutoAt = Date.now();
      rememberProposal(res.proposal);
      log.debug('auto trip →', res.proposal.name, 'p=' + res.proposal.prob);
      send('auto-trip', {});
    } else log.debug('auto: stayed put (' + (res && res.bestProb != null ? 'best ' + res.bestProb + ' < bar ' + res.threshold : 'no candidates') + ')');
  } catch (e) { log.debug('auto search failed', e.message); }
  autoBusy = false;
}

// ---------- live session: he works alongside you ----------
/* While it's on he follows each document you settle on and the text you're writing, and searches again whenever
   either changes. A strong match gets a full trip (at most one every 90 s); a decent one goes quietly onto his shelf
   (three chips beside him) for when you want it. Nothing is suggested twice in a session. */
const LIVE = { settleMs: 5000, minGapMs: 10000, tripGapMs: 90000, idleEndMs: 30 * 60000, shelfMax: 3 };
const live = { on: false, startedAt: 0, lastKey: '', lastSearchAt: 0, lastTripAt: 0, lastChangeAt: 0, busy: false, shelf: [], seen: new Set(), found: 0, kept: 0 };
function liveSummary() {
  const min = Math.max(1, Math.round((Date.now() - live.startedAt) / 60000));
  return min + ' min, ' + live.found + ' found' + (live.kept ? ', ' + live.kept + ' kept' : '');
}
function setLive(on) {
  if (on === live.on) return;
  if (on) {
    Object.assign(live, { on: true, startedAt: Date.now(), lastKey: '', lastSearchAt: 0, lastTripAt: 0, lastChangeAt: Date.now(), shelf: [], seen: new Set(), found: 0, kept: 0 });
    log.debug('[live] started');
    send('live', { on: true, note: 'Live session: I\u2019ll keep up with what you\u2019re working on' });
  } else {
    const note = 'Live session ended \u00b7 ' + liveSummary();
    log.debug('[live] ended', liveSummary());
    live.on = false; live.shelf = [];
    send('shelf', []); send('live', { on: false, note });
  }
}
function pushShelf() { send('shelf', live.shelf.map((p) => ({ id: p.id, name: p.name, ext: p.ext, reason: p.reason, path: p.path }))); }
async function liveCheck() {
  if (!win || live.busy || !engineStats.ready) return;
  const now = Date.now();
  if (now - live.lastChangeAt > LIVE.idleEndMs) { setLive(false); return; }
  if (rendererMode !== 'idle') return;
  const snap = context.snapshot();
  if (!snap.cleanTitle && !current.path) return;
  const key = snap.title + '|' + (snap.focusedText || '').slice(-200);
  if (key !== live.lastKey && live.pendingKey !== key) { live.pendingKey = key; live.lastChangeAt = now; }
  if (key === live.lastKey) return;
  if (now - snap.titleSince < LIVE.settleMs || now - live.lastChangeAt < 2500) return; // let you settle; let typing pause
  if (now - live.lastSearchAt < LIVE.minGapMs) return;
  live.lastKey = key; live.lastSearchAt = now; live.busy = true;
  try {
    const res = await engine.call('search', searchRequest('live', { exclude: [...live.seen] }), 15000);
    if (!live.on) return;
    if (!res || !res.found) { log.debug('[live] nothing for', JSON.stringify(snap.cleanTitle || '')); return; }
    const p = res.proposal, bar = res.threshold != null ? res.threshold : 0.5;
    if (live.seen.has(p.path)) return;
    if (p.prob >= bar && now - live.lastTripAt > LIVE.tripGapMs && rendererMode === 'idle') {
      live.seen.add(p.path); live.found++; live.lastTripAt = now;
      rememberProposal(p); pendingAuto = { res, at: now };
      log.debug('[live] trip →', p.name, 'p=' + p.prob, 'bar ' + bar);
      send('auto-trip', { live: true });
    } else if (p.prob >= Math.max(0.12, bar * 0.45)) {
      live.seen.add(p.path); live.found++;
      rememberProposal(p);
      live.shelf.unshift(p); if (live.shelf.length > LIVE.shelfMax) live.shelf.length = LIVE.shelfMax;
      log.debug('[live] shelf ←', p.name, 'p=' + p.prob, 'bar ' + bar);
      pushShelf();
    } else log.debug('[live] too weak:', p.name, 'p=' + p.prob, 'bar ' + bar);
  } catch (e) { log.debug('[live] search failed', e.message); }
  finally { live.busy = false; }
}
ipcMain.handle('gofer:shelf-take', (_e, id) => {
  const i = live.shelf.findIndex((p) => p.id === id); if (i < 0) return null;
  const [p] = live.shelf.splice(i, 1); pushShelf(); return p;
});
ipcMain.on('gofer:shelf-drop', (_e, id) => {
  const i = live.shelf.findIndex((p) => p.id === id); if (i < 0) return;
  const [p] = live.shelf.splice(i, 1); pushShelf();
  log.outcome(p.id, 'dismiss'); engine.call('outcome', { id: p.id, outcome: 'dismiss' }).catch(() => {});
});
ipcMain.on('gofer:live', (_e, on) => setLive(!!on));

function rememberProposal(p) {
  proposalPaths.set(p.id, p); if (proposalPaths.size > 200) proposalPaths.delete(proposalPaths.keys().next().value);
  log.proposal(p, context.snapshot());
}

// ---------- IPC from the renderer ----------
/* Click-through: the window ignores the mouse except over Skitter, his card and his text box.
   We decide that here by polling the cursor against the zones the renderer reports, instead of relying only on
   Windows forwarding mouse moves to a click-through window (which some setups never do). */
let zones = [], rendererWants = false;
function applyInteractive() {
  if (!win || win.isDestroyed()) return;
  let inside = false;
  if (zones.length) {
    const p = screen.getCursorScreenPoint(), b = win.getBounds(), x = p.x - b.x, y = p.y - b.y;
    inside = zones.some(([zx, zy, zw, zh]) => x >= zx && x <= zx + zw && y >= zy && y <= zy + zh);
  }
  const want = inside || rendererWants;
  // Re-send the state now and then even when it hasn't changed: Windows can drop it when the window is
  // re-shown or loses its top spot, and then he stops answering clicks while we think he's fine.
  const now = Date.now();
  if (want !== interactive || now - lastApplied > 1000) {
    if (want !== interactive) {
      // While the pointer is over him or his card the window can take focus, so a click on him activates
      // it the normal Windows way and the task box gets the keyboard. Asking for focus after the click
      // fails whenever another app (a document that just opened, a dialog) holds the foreground.
      if (want) win.setFocusable(true);
      else if (rendererMode !== 'ask' && !win.isFocused()) win.setFocusable(false);
    }
    interactive = want; lastApplied = now;
    win.setIgnoreMouseEvents(!want, { forward: !process.env.GOFER_NO_FORWARD });
  }
}
let lastApplied = 0;
function reassertOverlay() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  if (!win.isVisible()) win.showInactive();
  lastApplied = 0; applyInteractive();
}
ipcMain.on('gofer:interactive', (_e, on) => { rendererWants = !!on; applyInteractive(); });
ipcMain.on('gofer:zones', (_e, z) => { zones = Array.isArray(z) ? z.filter((r) => Array.isArray(r) && r.length === 4) : []; if (process.env.GOFER_DEBUG) log.debug('[zones]', JSON.stringify(zones)); applyInteractive(); });
setInterval(applyInteractive, 40);
ipcMain.on('gofer:focus', (_e, on) => {
  if (!win) return;
  if (on) takeFocus();
  else giveBackFocus();
});
// The task box needs the keyboard. Windows only lets a background app take the foreground in narrow
// cases, and right after a document app opens it often refuses; re-raising our top spot first and
// asking twice gets it reliably. (The old hide()/showInactive() way of handing focus back left the
// window ignoring clicks on some PCs, so he answered once and never again.)
function takeFocus() {
  if (!win || win.isDestroyed()) return;
  win.setFocusable(true);
  if (process.platform === 'win32') { win.setAlwaysOnTop(false); win.setAlwaysOnTop(true, 'screen-saver', 1); }
  win.focus(); win.webContents.focus();
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isFocused()) { win.focus(); win.webContents.focus(); log.debug('[focus] second try', win.isFocused()); } }, 120);
}
function giveBackFocus() {
  if (!win || win.isDestroyed()) return;
  win.blur(); win.setFocusable(false);
  reassertOverlay();
}
ipcMain.on('gofer:mode', (_e, m) => { if (m !== rendererMode) log.debug('[mode]', m); rendererMode = m; });
ipcMain.on('gofer:click', (_e, c) => log.debug('[click]', c));
ipcMain.on('gofer:menu', async () => {
  if (!win) return;
  await refreshStats();
  win.setFocusable(true); win.focus();
  buildMenu().popup({ window: win, callback: giveBackFocus });
});
ipcMain.on('gofer:ui', (_e, ui) => { if (ui && typeof ui.eyelineFrac === 'number') settings.set('eyelineFrac', ui.eyelineFrac); });
ipcMain.handle('gofer:state', () => ({ ready: engineStats.ready, count: engineStats.count, presentTimeoutSec: settings.get('presentTimeoutSec'), eyelineFrac: settings.get('eyelineFrac'),
  tripPace: settings.get('tripPace'), firstRun: !!settings.get('firstRun'), autoMode: !!settings.get('autoMode') }));

ipcMain.handle('gofer:fetch', async (_e, req) => {
  const mode = (req && req.mode) || 'task';
  try {
    if ((mode === 'auto' || mode === 'live') && pendingAuto && Date.now() - pendingAuto.at < 120000 && !(req.exclude && req.exclude.length)) { const r = pendingAuto.res; pendingAuto = null; return r; }
    pendingAuto = null;
    const request = searchRequest(mode, { task: req.task || null, exclude: req.exclude || [] });
    if (mode === 'task') lastRequest = Object.assign({}, request, { exclude: [] });
    const res = await engine.call('search', request, 20000);
    if (res && res.found) rememberProposal(res.proposal);
    log.debug('fetch', mode, JSON.stringify(res.query || ''), '→', res.found ? res.proposal.name + ' p=' + res.proposal.prob + ' (' + res.ms + 'ms)' : 'nothing');
    return res;
  } catch (e) { log.debug('fetch failed', e.message); return { found: false, error: e.message }; }
});

/* A picture of the file for the card. Order: the file itself (photos), Windows' own thumbnail (what Explorer shows),
   then what Skitter can render (PDF first page, the cover image saved inside Office files). Cached per file version. */
const previewCache = new Map();
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg']);
const RENDER_FIRST = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods']); // real page beats a generic icon
async function makePreview(p) {
  let st; try { st = fs.statSync(p); } catch (e) { return null; }
  if (process.platform === 'win32' && st.size > 4096 && st.blocks === 0) return { note: 'Online-only in OneDrive, so no preview' }; // don't download it to draw it
  const key = p + '|' + st.mtimeMs;
  if (previewCache.has(key)) return previewCache.get(key);
  const ext = path.extname(p).toLowerCase(); const W = 640;
  const fromImage = (img) => { if (!img || img.isEmpty()) return null; const sz = img.getSize(); if (sz.width < 16 || sz.height < 16) return null; const out = sz.width > W ? img.resize({ width: W, quality: 'good' }) : img; return { kind: 'image', dataUrl: out.toDataURL(), width: out.getSize().width, height: out.getSize().height }; };
  const shell = async () => { if (process.platform !== 'win32' && process.platform !== 'darwin') return null; try { return fromImage(await nativeImage.createThumbnailFromPath(p, { width: W, height: 480 })); } catch (e) { return null; } };
  const own = async () => { try { return await engine.call('preview', { path: p, width: W }, 12000); } catch (e) { return null; } };
  let out = null;
  if (IMAGE_EXT.has(ext) && st.size < 40e6) out = fromImage(nativeImage.createFromPath(p));
  if (!out && RENDER_FIRST.has(ext)) out = (await own()) || (await shell());
  if (!out) out = await shell();
  previewCache.set(key, out); if (previewCache.size > 40) previewCache.delete(previewCache.keys().next().value);
  return out;
}
ipcMain.handle('gofer:preview', async (_e, id) => {
  const prop = proposalPaths.get(id); if (!prop) return null;
  const t0 = Date.now(); const out = await makePreview(prop.path);
  log.debug('preview', path.basename(prop.path), out ? (out.kind || out.note) : 'none', (Date.now() - t0) + 'ms');
  return out;
});

ipcMain.handle('gofer:decide', async (_e, d) => {
  if (!d || !d.id) return;
  const p = proposalPaths.get(d.id);
  log.outcome(d.id, d.outcome);
  engine.call('outcome', { id: d.id, outcome: d.outcome }).catch((e) => log.debug('outcome failed', e.message));
  if (!p) return;
  if (live.on && (d.outcome === 'accept' || d.outcome === 'reveal')) live.kept++;
  if (d.outcome === 'accept') { const err = await shell.openPath(p.path); if (err) log.debug('open failed', err); setTimeout(reassertOverlay, 1500); setTimeout(reassertOverlay, 4000); }
  else if (d.outcome === 'reveal') shell.showItemInFolder(p.path);
});

// ---------- scripted smoke test (GOFER_SMOKE=<outdir>) ----------
async function smokeTest() {
  const out = process.env.GOFER_SMOKE; fs.mkdirSync(out, { recursive: true });
  const shot = async (name) => { try { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(out, name + '.png'), img.toPNG()); log.debug('[smoke] saved', name); } catch (e) { log.debug('[smoke] shot failed', e.message); } };
  const js = (code) => win.webContents.executeJavaScript(code).catch((e) => log.debug('[smoke] js error', e.message));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && !engineStats.ready; i++) await sleep(500);
  await sleep(1500); await shot('00-idle');
  const t0 = Date.now();
  const q = process.env.GOFER_SMOKE_QUERY || 'how much will the event cost to put on';
  js('window.__gofer.runTrip(\'task\', ' + JSON.stringify(q) + ', [], false)');
  const plan = process.env.GOFER_SMOKE_PLAN ? JSON.parse(process.env.GOFER_SMOKE_PLAN) : [1200, 2400, 3600];
  for (let i = 0; i < plan.length; i++) { await sleep(Math.max(0, plan[i] - (Date.now() - t0))); await shot(String(i + 1).padStart(2, '0') + '-t' + plan[i]); }
  for (let i = 0; i < 40 && rendererMode !== 'present'; i++) await sleep(100);
  log.debug('[smoke] presenting after', Date.now() - t0, 'ms; mode', rendererMode);
  await shot('07-presenting');
  await sleep(1500); await shot('08-preview');
  await js("document.getElementById('card').classList.add('wide')"); await sleep(600); await shot('09-wide');
  await js("(() => { const k = document.getElementById('cardName'); for (const t of ['mousedown', 'mouseup']) k.dispatchEvent(new MouseEvent(t, { bubbles: true, button: 0 })); })()");
  await sleep(800);
  await refreshStats();
  log.debug('[smoke] stats', JSON.stringify({ count: engineStats.count, semantic: engineStats.semantic, embedded: engineStats.embeddedChunks, summary: engineStats.summary }));
  app.quit();
}

// ---------- boot ----------
/* Skitter used to be called Gofer: carry over its data (index, learning, settings) and remove the old install once. */
function migrateFromGofer() {
  if (process.env.GOFER_USERDATA) return;
  try {
    const { execFileSync, spawn } = require('child_process');
    const oldDir = path.join(app.getPath('appData'), 'Gofer'), newDir = app.getPath('userData');
    if (!fs.existsSync(oldDir) || fs.existsSync(path.join(newDir, 'gofer.db'))) return;
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/IM', 'Gofer.exe', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (e) {} }
    fs.mkdirSync(newDir, { recursive: true });
    for (const f of fs.readdirSync(oldDir)) {
      const from = path.join(oldDir, f), to = path.join(newDir, f);
      if (fs.existsSync(to)) continue;
      try { fs.renameSync(from, to); } catch (e) { try { fs.cpSync(from, to, { recursive: true }); } catch (_) {} }
    }
    const oldUninstaller = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Gofer', 'Uninstall Gofer.exe');
    if (process.platform === 'win32' && app.isPackaged && fs.existsSync(oldUninstaller)) spawn(oldUninstaller, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) { /* best effort */ }
}

app.whenReady().then(async () => {
  try {
    migrateFromGofer();
    settings = new Settings(userFile('settings.json'));
    log = new Log(app.getPath('userData'));
    log.debug('Skitter starting', app.getVersion(), process.platform, 'userData=' + app.getPath('userData'));
    { // Windows' own idea of Documents / Desktop / Downloads, which follows OneDrive redirection; replaces the old guessed default
      const home = require('os').homedir();
      const legacy = [path.join(home, 'Documents'), path.join(home, 'Desktop')];
      const roots = settings.get('roots') || [];
      if (roots.length === legacy.length && roots.every((r, i) => r === legacy[i])) {
        const known = ['documents', 'desktop', 'downloads'].map((k) => { try { return app.getPath(k); } catch (e) { return null; } }).filter((p) => p && fs.existsSync(p));
        const uniq = [...new Set(known)];
        if (uniq.length) { settings.set('roots', uniq); log.debug('folders:', uniq.join(' | ')); }
      }
    }
    try { fs.unlinkSync(userFile('index.json')); } catch (e) {} // pre-0.2 index format

    context = new Context({ clipboard, shell, helperScript: path.join(__dirname, 'winhelper.ps1'), log: (...a) => log.debug('[ctx]', ...a) });
    engine = new EngineClient();
    engine.start({ dbFile: userFile('gofer.db'), modelDir: modelDir(),
      roots: process.env.GOFER_ROOTS ? process.env.GOFER_ROOTS.split(path.delimiter) : settings.get('roots'), semantic: !!settings.get('semantic'), autoTarget: settings.get('autoTargetPrecision'), maxEmbedChunks: settings.get('maxEmbedChunks') })
      .then((st) => { engineStats = Object.assign(engineStats, st); send('index-progress', st); })
      .catch((e) => log.debug('engine init failed', e.message));

    context.on('foreground', onForeground);
    context.on('opened', (items) => engine.call('opened', { items }).catch(() => {}));
    context.start();

    createOverlay();
    try { createTray(); } catch (e) { log.debug('tray failed', e.message); }
    screen.on('display-metrics-changed', relayout);
    screen.on('display-added', relayout);
    screen.on('display-removed', relayout);

    setInterval(autoCheck, 4000);
    setInterval(() => { if (live.on) liveCheck(); }, 1500);
    if (process.env.GOFER_LIVE) setTimeout(() => setLive(true), 1500);
    try { globalShortcut.register('CommandOrControl+Alt+L', () => setLive(!live.on)); } catch (e) { log.debug('live shortcut unavailable', e.message); }
    setupUpdates();
    setInterval(() => engine.call('rescan', {}).catch(() => {}), 6 * 3600 * 1000); // safety net behind the folder watcher
    if (settings.get('firstRun')) {
      if (process.platform === 'win32' && app.isPackaged && !IS_STORE && !process.env.GOFER_SMOKE) app.setLoginItemSettings({ openAtLogin: true }); // a desktop companion should be there when you log in; untick in the menu
      setTimeout(() => settings.set('firstRun', false), 15000);
    }
  } catch (e) {
    try { log.debug('boot failed', e.stack || e.message); } catch (_) {}
    dialog.showErrorBox('Skitter could not start', String(e.stack || e.message)); app.quit();
  }
});

app.on('second-instance', () => send('ask', {}));
app.on('window-all-closed', () => { /* tray app: keep running */ });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) {} });
app.on('before-quit', () => { app.isQuitting = true; if (context) context.stop(); if (engine) engine.call('shutdown', {}, 2000).catch(() => {}); });
