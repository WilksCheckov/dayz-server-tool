'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const EVENTS = ['console', 'task', 'server:status', 'mods:changed', 'mods:progress', 'steam:guardNeeded', 'updater:state', 'backups:state', 'backups:changed', 'scheduler:state', 'rcon:state', 'rcon:message', 'discord:state', 'website:state', 'health:sample', 'alerts:new', 'crashes:changed', 'players:changed', 'update:state', 'tasks:changed', 'steam:changed', 'accounts:changed', 'domain:state', 'map:progress', 'audit:new', 'deathlog:changed'];

contextBridge.exposeInMainWorld('api', {
  invoke: call,
  // Real filesystem path of a dropped File (folders included), for drag-and-drop imports.
  pathForFile(file) { try { return webUtils.getPathForFile(file); } catch { return file && file.path; } },
  on(channel, cb) {
    if (!EVENTS.includes(channel)) throw new Error('Unknown event ' + channel);
    const listener = (_e, data) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
