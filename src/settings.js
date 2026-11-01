'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function defaults() {
  const home = os.homedir();
  return {
    // folders Gofer may dig through
    roots: [path.join(home, 'Documents'), path.join(home, 'Desktop')],
    // go looking on his own when you settle on a document
    autoMode: true,
    autoCooldownMin: 4,         // minimum minutes between unassigned trips
    autoSettleSec: 20,          // how long you stay in one window before it counts as "working on it"
    autoTargetPrecision: 0.6,   // unassigned trips should be kept at least this often; the bar self-adjusts to meet it
    semantic: true,             // search by meaning (downloads a 23 MB model once, runs locally)
    presentTimeoutSec: 14,      // how long the card waits before it counts as a soft no
    eyelineFrac: 0.22,          // where on the right edge he sits (fraction of screen height)
    displayId: null,            // which screen he lives on (null = primary)
    tripPace: 'brisk',          // 'brisk' (about 5 s round trip) or 'stroll' (about 9 s)
    maxEmbedChunks: 60000,      // cap on passages indexed by meaning (newest files first)
    firstRun: true
  };
}

class Settings {
  constructor(file) { this.file = file; this.data = defaults(); this.load(); }
  load() {
    try { const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.data = Object.assign(defaults(), raw); }
    catch (e) { this.save(); }
  }
  save() {
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); } catch (e) { /* ignore */ }
  }
  get(k) { return this.data[k]; }
  set(k, v) { this.data[k] = v; this.save(); }
}

module.exports = { Settings, defaults };
