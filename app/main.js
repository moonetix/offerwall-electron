'use strict';

const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('node:path');

// Your backend. Use https in production; EARN_API_URL overrides it during development.
const API = (process.env.EARN_API_URL || 'http://localhost:3000').replace(/\/+$/, '');
// 'browser' (recommended) opens the wall with shell.openExternal, 'window' in a locked-down BrowserWindow.
const OPEN_WALL_IN = process.env.OPEN_WALL_IN === 'window' ? 'window' : 'browser';
const WALL_ORIGIN = 'https://wall.moonetix.com';

let mainWindow = null;
let wallWindow = null;
// The sign-in token stays in the main process and never reaches the page.
// To keep users signed in across restarts, store it with safeStorage.encryptStringAsync.
let sessionToken = null;

// Compares the parsed origin: a startsWith test would let https://wall.moonetix.com.example.net through.
function isWallUrl(value) {
  try {
    return new URL(value).origin === WALL_ORIGIN;
  } catch {
    return false;
  }
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

async function api(method, route, body) {
  const headers = {};
  if (sessionToken) headers.Authorization = 'Bearer ' + sessionToken;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + route, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) sessionToken = null;
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'http_' + res.status);
  return data;
}

// Every handler answers { ok: true, ... } or { ok: false, error }, so the page never sees a stack trace.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'blocked' };
    try {
      return { ok: true, ...(await fn(...args)) };
    } catch (err) {
      return { ok: false, error: err.message === 'fetch failed' ? 'server_unreachable' : err.message };
    }
  });
}

function credentials(input) {
  const email = typeof input?.email === 'string' ? input.email.slice(0, 254) : '';
  const password = typeof input?.password === 'string' ? input.password.slice(0, 200) : '';
  return { email, password };
}

handle('auth:register', async (input) => {
  const { token } = await api('POST', '/api/register', { ...credentials(input), over16: input?.over16 === true });
  sessionToken = token;
  return {};
});

handle('auth:login', async (input) => {
  const { token } = await api('POST', '/api/login', credentials(input));
  sessionToken = token;
  return {};
});

handle('auth:logout', async () => {
  await api('POST', '/api/logout').catch(() => {});
  sessionToken = null;
  return {};
});

handle('auth:status', async () => ({ signedIn: sessionToken !== null }));

handle('wallet:balance', async () => {
  const me = await api('GET', '/api/me');
  return { balance: me.balance, currency: me.currency };
});

// A fresh link per click, signed by your server for the signed-in account.
handle('offerwall:open', async () => {
  const { url } = await api('GET', '/api/offerwall-link');
  if (!isWallUrl(url)) throw new Error('unexpected_url');
  if (OPEN_WALL_IN === 'window') {
    openWallWindow(url);
  } else {
    await shell.openExternal(url);
  }
  return { where: OPEN_WALL_IN };
});

// Alternative to the browser: the wall in its own window, with no Node.js, no preload,
// an in-memory session that denies every permission, and every offer sent to the browser.
function openWallWindow(url) {
  if (wallWindow && !wallWindow.isDestroyed()) {
    wallWindow.loadURL(url);
    wallWindow.focus();
    return;
  }
  const wallSession = session.fromPartition('offerwall');
  wallSession.setPermissionRequestHandler((contents, permission, callback) => callback(false));
  wallSession.setPermissionCheckHandler(() => false);

  wallWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    parent: mainWindow,
    title: 'Earn points',
    autoHideMenuBar: true,
    webPreferences: {
      session: wallSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const contents = wallWindow.webContents;
  // Offers open in a new tab on the wall. They continue in the user's browser.
  contents.setWindowOpenHandler(({ url: target }) => {
    if (isHttpsUrl(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  const stayOnWall = (event) => {
    if (isWallUrl(event.url)) return;
    event.preventDefault();
    if (isHttpsUrl(event.url)) shell.openExternal(event.url);
  };
  contents.on('will-navigate', stayOnWall);
  contents.on('will-redirect', stayOnWall);
  wallWindow.on('closed', () => {
    wallWindow = null;
  });
  wallWindow.loadURL(url);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 640,
    title: 'Earn Points Example',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The app's own page never navigates or opens windows.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  return mainWindow;
}

app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

module.exports = { isWallUrl, isHttpsUrl };
