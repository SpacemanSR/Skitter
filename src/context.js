'use strict';
/* What Gofer can see of your work: the foreground window, the text around your cursor, recent clipboard text,
   and the files Windows lists as recently opened. Everything stays on this computer. */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

/* Fallback when the event-driven helper can't start (e.g. PowerShell compilation blocked): poll the title. */
const PS_POLL = `
$sig = @'
using System; using System.Runtime.InteropServices; using System.Text;
public class GoferWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$last = ""
while ($true) {
  try {
    $h = [GoferWin]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 1024
    [void][GoferWin]::GetWindowText($h, $sb, 1024)
    $pid2 = [uint32]0
    [void][GoferWin]::GetWindowThreadProcessId($h, [ref]$pid2)
    $pname = ""
    try { $pname = (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName } catch {}
    $line = $pname + [char]9 + $sb.ToString()
    if ($line -ne $last) { $last = $line; [Console]::Out.WriteLine($line); [Console]::Out.Flush() }
  } catch {}
  Start-Sleep -Milliseconds 1200
}`;

const APP_SUFFIXES = /\s+[-–—|]\s+(Google Chrome|Microsoft Edge|Mozilla Firefox|Firefox|Brave|Opera|Vivaldi|Arc|Word|Excel|PowerPoint|Outlook|OneNote|Notepad\+\+|Notepad|Visual Studio Code|Visual Studio|Cursor|Obsidian|Notion|Sublime Text|Figma|Slack|Discord|Adobe [A-Za-z ]+|Photoshop|Premiere Pro|After Effects|DaVinci Resolve|Audacity|OBS( Studio)?|Godot( Engine)?|Unity|Unreal Editor|Blender|Spotify|File Explorer|Explorer|Windows Terminal|Command Prompt|Windows PowerShell|PowerShell|Claude|ChatGPT|Gemini|Zoom|Teams|Microsoft Teams|Mail|Calendar|Finder|Typora|Scrivener|Final Draft|Acrobat Reader|Adobe Acrobat|Foxit Reader|Paint|Snipping Tool|Steam|Epic Games Launcher|Google Docs|Google Sheets|Google Slides|Google Drive|Gmail|YouTube|Canva|Trello|Asana|GitHub|Reddit|X|Twitter|LinkedIn|Dropbox|OneDrive|Miro|Loom|Twitch)\s*$/i;
const GENERIC_TITLES = new Set(['', 'program manager', 'task switching', 'start', 'search', 'windows default lock screen', 'new tab', 'untitled', 'home', 'desktop', 'settings', 'task view', 'action center', 'notification center', 'gofer', 'downloads', 'documents', 'this pc', 'file explorer', 'recycle bin', 'pictures', 'videos', 'music', 'quick access', 'inbox', 'calendar', 'mail']);
const SELF = new Set(['gofer', 'electron']);

/* Strip the app name and noise from a window title, leaving the part that names the work. */
function cleanTitle(title, processName) {
  if (!title) return '';
  let t = String(title).replace(/^[●•*]\s*/, '').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, ' ').replace(/\(Unsaved\)|\[Unsaved\]|\(Read-Only\)|\[Read-Only\]|\[Compatibility Mode\]|\(\d+ unread\)|\(\d+\)/gi, ' ').trim();
  let guard = 0;
  while (guard++ < 3) { const n = t.replace(APP_SUFFIXES, ''); if (n === t) break; t = n.trim(); }
  if (processName) {
    const pn = processName.toLowerCase(); const parts = t.split(/\s+[-–—|]\s+/);
    if (parts.length > 1 && parts[parts.length - 1].toLowerCase().replace(/\s+/g, '').includes(pn.replace(/\s+/g, ''))) { parts.pop(); t = parts.join(' - '); }
  }
  t = t.replace(/\.(docx?|pptx?|xlsx?|pdf|txt|md|rtf|png|jpe?g|mp4|wav|mp3|aep|prproj|psd|ai|blend|godot|tscn|gd|js|ts|py|html?|css|json)\b/gi, ' ').replace(/\s+/g, ' ').replace(/^[\s\-–—|:]+|[\s\-–—|:]+$/g, '').trim();
  if (GENERIC_TITLES.has(t.toLowerCase())) return '';
  return t;
}

class Context extends EventEmitter {
  constructor(opts) {
    super();
    this.clipboard = opts.clipboard; this.shell = opts.shell; this.log = opts.log || (() => {});
    this.helperScript = opts.helperScript;
    this.fg = { process: '', title: '', clean: '', since: Date.now() };
    this.lastReal = { process: '', title: '', clean: '', since: Date.now() };
    this.focused = { text: '', src: '', at: 0, title: '' };
    this.clips = []; this.recent = []; this._recentSeen = new Map();
    this._helper = null; this._mode = 'none'; this._pending = new Map(); this._seq = 0; this._timers = []; this._stopped = false;
  }

  start() {
    this._startForeground();
    this._timers.push(setInterval(() => this._pollClipboard(), 1500)); this._pollClipboard();
    this._timers.push(setInterval(() => this._pollRecent(), 45000)); this._pollRecent();
    // keep a fresh copy of the text around the cursor while you stay in one window
    this._timers.push(setInterval(() => { if (this.lastReal.title && Date.now() - this.focused.at > 15000) this.refreshFocusedText(); }, 5000));
  }
  stop() { this._stopped = true; this._timers.forEach(clearInterval); if (this._helper) { try { this._helper.stdin.write('quit\n'); } catch (e) {} try { this._helper.kill(); } catch (e) {} } }
  mode() { return this._mode; }

  _startForeground() {
    if (process.platform !== 'win32') { if (process.env.GOFER_FAKE_TITLE) this._onForeground('testapp', process.env.GOFER_FAKE_TITLE); return; }
    if (this.helperScript && fs.existsSync(this.helperScript)) this._spawnHelper(); else this._spawnPoller();
  }

  _spawnHelper() {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', this.helperScript], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this._helper = p; let buf = '', ready = false, errText = '';
    const giveUp = setTimeout(() => { if (!ready) { this.log('context helper did not start; falling back to polling. ' + errText.slice(0, 300)); try { p.kill(); } catch (e) {} } }, 20000);
    p.stdout.on('data', (d) => {
      buf += d.toString('utf8'); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
        let m; try { m = JSON.parse(line); } catch (e) { continue; }
        if (m.t === 'ready') { ready = true; clearTimeout(giveUp); this._mode = 'events'; this.log('context helper ready (event-driven)'); }
        else if (m.t === 'fg') this._onForeground(m.proc, m.title);
        else if (m.t === 'text') { const r = this._pending.get(String(m.id)); if (r) { this._pending.delete(String(m.id)); r(m); } }
      }
    });
    p.stderr.on('data', (d) => { errText += d.toString(); if (errText.length > 4000) errText = errText.slice(-4000); });
    p.on('exit', (code) => {
      clearTimeout(giveUp); this._helper = null; this._mode = 'none';
      for (const r of this._pending.values()) r({ text: '', src: 'gone' }); this._pending.clear();
      if (this._stopped) return;
      this.log('context helper exited (' + code + ')' + (errText ? ': ' + errText.slice(0, 400) : ''));
      if (!ready) this._spawnPoller(); else setTimeout(() => this._spawnHelper(), 3000);
    });
  }

  _spawnPoller() {
    const enc = Buffer.from(PS_POLL, 'utf16le').toString('base64');
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this._mode = 'polling'; let buf = '';
    p.stdout.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); const tab = line.indexOf('\t'); if (tab >= 0) this._onForeground(line.slice(0, tab), line.slice(tab + 1)); } });
    p.on('exit', () => { this._mode = 'none'; if (!this._stopped) setTimeout(() => this._spawnPoller(), 5000); });
  }

  _onForeground(processName, title) {
    const now = Date.now();
    this.fg = { process: processName, title, clean: cleanTitle(title, processName), since: now };
    if (SELF.has((processName || '').toLowerCase()) || (title || '').trim().toLowerCase() === 'gofer') return; // ignore ourselves
    if (title === this.lastReal.title && processName === this.lastReal.process) return;
    this.lastReal = this.fg;
    this.focused = { text: '', src: '', at: 0, title: '' };
    this.emit('foreground', this.fg);
    setTimeout(() => { if (this.lastReal === this.fg) this.refreshFocusedText(); }, 1800);
  }

  /* Ask the helper for the text around the cursor in the focused control. Only while a real (non-Gofer) window is in front. */
  refreshFocusedText() {
    if (!this._helper || this._mode !== 'events') return Promise.resolve(null);
    if (SELF.has((this.fg.process || '').toLowerCase())) return Promise.resolve(null);
    const id = String(++this._seq); const forTitle = this.lastReal.title;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this._pending.delete(id); resolve(null); }, 4000);
      this._pending.set(id, (m) => {
        clearTimeout(timer);
        if (forTitle === this.lastReal.title && m.text != null) this.focused = { text: String(m.text).slice(-2500), src: m.src, at: Date.now(), title: forTitle };
        resolve(m);
      });
      try { this._helper.stdin.write('text ' + id + '\n'); } catch (e) { clearTimeout(timer); this._pending.delete(id); resolve(null); }
    });
  }

  _pollClipboard() {
    if (!this.clipboard) return;
    let text = ''; try { text = String(this.clipboard.readText() || ''); } catch (e) { return; }
    text = text.trim(); if (text.length < 3 || text.length > 20000) return;
    if (this.clips[0] && this.clips[0].text === text) return;
    this.clips.unshift({ text, ts: Date.now() }); this.clips = this.clips.slice(0, 10);
  }

  async _pollRecent() {
    if (process.platform !== 'win32' || !this.shell) return;
    const dir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Recent');
    try {
      const names = (await fs.promises.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.lnk'));
      const items = [];
      for (const n of names) { try { const st = await fs.promises.stat(path.join(dir, n)); items.push({ lnk: path.join(dir, n), mtime: st.mtimeMs }); } catch (e) {} }
      items.sort((a, b) => b.mtime - a.mtime);
      const out = [], fresh = [];
      for (const it of items.slice(0, 60)) {
        let target = null; try { const d = this.shell.readShortcutLink(it.lnk); target = d && d.target; } catch (e) {}
        if (!target || !/\.[a-z0-9]{1,5}$/i.test(target)) continue;
        out.push({ path: target, ts: it.mtime });
        const prev = this._recentSeen.get(target);
        if (prev !== it.mtime) { this._recentSeen.set(target, it.mtime); if (prev !== undefined || this._recentPrimed) fresh.push({ path: target, ts: it.mtime, src: 'recent' }); else fresh.push({ path: target, ts: it.mtime, src: 'recent-initial' }); }
        if (out.length >= 40) break;
      }
      this._recentPrimed = true;
      this.recent = out;
      if (fresh.length) this.emit('opened', fresh);
    } catch (e) { /* no Recent folder */ }
  }

  snapshot() {
    const now = Date.now();
    const clip = this.clips.find((c) => now - c.ts < 10 * 60000);
    const focusedOk = this.focused.text && this.focused.title === this.lastReal.title && now - this.focused.at < 120000;
    return {
      title: this.lastReal.title, cleanTitle: this.lastReal.clean, process: this.lastReal.process, titleSince: this.lastReal.since,
      focusedText: focusedOk ? this.focused.text : '', focusedSrc: focusedOk ? this.focused.src : '',
      clip: clip ? clip.text.replace(/\s+/g, ' ').slice(0, 300) : '',
      recent: this.recent.slice(0, 40)
    };
  }
}

module.exports = { Context, cleanTitle };
