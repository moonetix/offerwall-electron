'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// One narrow function per message. The page never gets ipcRenderer itself.
contextBridge.exposeInMainWorld('earn', {
  status: () => ipcRenderer.invoke('auth:status'),
  register: (email, password, over16) => ipcRenderer.invoke('auth:register', { email, password, over16 }),
  login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getBalance: () => ipcRenderer.invoke('wallet:balance'),
  openOfferwall: () => ipcRenderer.invoke('offerwall:open'),
});
