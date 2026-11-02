'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gofer', {
  platform: process.platform,
  setInteractive: (on) => ipcRenderer.send('gofer:interactive', !!on),
  focus: (on) => ipcRenderer.send('gofer:focus', !!on),
  fetch: (req) => ipcRenderer.invoke('gofer:fetch', req),
  decide: (d) => ipcRenderer.invoke('gofer:decide', d),
  preview: (id) => ipcRenderer.invoke('gofer:preview', id),
  menu: (pt) => ipcRenderer.send('gofer:menu', pt),
  mode: (m) => ipcRenderer.send('gofer:mode', m),
  hitZones: (z) => ipcRenderer.send('gofer:zones', z),
  click: (c) => ipcRenderer.send('gofer:click', c),
  getState: () => ipcRenderer.invoke('gofer:state'),
  saveUi: (ui) => ipcRenderer.send('gofer:ui', ui),
  on: (channel, fn) => { const h = (_e, data) => fn(data); ipcRenderer.on('gofer:' + channel, h); return () => ipcRenderer.removeListener('gofer:' + channel, h); }
});
