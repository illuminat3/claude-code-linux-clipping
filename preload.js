'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const url = require('url');

contextBridge.exposeInMainWorld('api', {
  recorder: {
    start: () => ipcRenderer.invoke('recorder:start'),
    stop: () => ipcRenderer.invoke('recorder:stop'),
    getStatus: () => ipcRenderer.invoke('recorder:getStatus'),
    saveClip: () => ipcRenderer.invoke('clip:save'),
  },

  clips: {
    list: () => ipcRenderer.invoke('clips:list'),
    delete: (clipId) => ipcRenderer.invoke('clips:delete', clipId),
    openFolder: () => ipcRenderer.invoke('clips:openFolder'),
    trim: (clipId, trimStart, trimEnd) => ipcRenderer.invoke('clip:trim', clipId, trimStart, trimEnd),
  },

  config: {
    get: (key) => ipcRenderer.invoke('config:get', key),
    set: (key, value) => ipcRenderer.invoke('config:set', key, value),
  },

  dialog: {
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  },

  pathToFileUrl: (p) => url.pathToFileURL(p).href,

  platform: process.platform,

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close:    () => ipcRenderer.invoke('window:close'),
  },

  on: (channel, callback) => {
    const allowed = [
      'recorder:status',
      'recorder:error',
      'clip:saved',
      'clip:saving',
      'clip:error',
    ];
    if (allowed.includes(channel)) {
      const wrapped = (_event, ...args) => callback(...args);
      ipcRenderer.on(channel, wrapped);
      // Return a cleanup function
      return () => ipcRenderer.removeListener(channel, wrapped);
    }
  },
});
