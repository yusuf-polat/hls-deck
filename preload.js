'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  parseCurl: (text) => ipcRenderer.invoke('curl:parse', text),
  list: () => ipcRenderer.invoke('streams:list'),
  save: (stream) => ipcRenderer.invoke('streams:save', stream),
  remove: (id) => ipcRenderer.invoke('streams:delete', id),
  importCurl: (text) => ipcRenderer.invoke('streams:import-curl', text),
  prepare: (id) => ipcRenderer.invoke('player:prepare', id),
  exportAll: () => ipcRenderer.invoke('streams:export'),
  importFile: () => ipcRenderer.invoke('streams:import-file'),
  bridgeInfo: () => ipcRenderer.invoke('bridge:info'),
  bridgeRegenerate: () => ipcRenderer.invoke('bridge:regenerate'),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  extStatus: () => ipcRenderer.invoke('ext:status'),
  extInstall: (browserId) => ipcRenderer.invoke('ext:install', browserId),
  extReveal: () => ipcRenderer.invoke('ext:reveal'),
  extSkip: () => ipcRenderer.invoke('ext:skip'),
  onBridgeClient: (cb) => ipcRenderer.on('bridge-client', (_e, d) => cb(d)),
  onBridgeImport: (cb) => ipcRenderer.on('bridge-import', (_e, d) => cb(d)),
  onTokenRefreshed: (cb) => ipcRenderer.on('token-refreshed', (_e, d) => cb(d)),
  onUpstreamError: (cb) => ipcRenderer.on('upstream-error', (_e, d) => cb(d)),
  onSmoke: (cb) => ipcRenderer.on('smoke', (_e, text) => cb(text)),
  log: (event, data) => ipcRenderer.send('log', event, data),
});
