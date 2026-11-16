'use strict';
// Clipzy desktop app: a dedicated window for your hosted Clipzy site (like Discord's desktop app).
// Set the site address in config.json before building.
const { app, BrowserWindow, shell, session, desktopCapturer, Menu } = require('electron');
const path = require('path');
const { url: APP_URL } = require('./config.json');

const ORIGIN = new URL(APP_URL).origin;
let win = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 380,
    minHeight: 600,
    title: 'Clipzy',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#0e0e10',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadURL(APP_URL);

  // Links to other sites open in the normal browser; Clipzy pages stay in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === ORIGIN) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== ORIGIN) { e.preventDefault(); shell.openExternal(url); }
  });
  // Friendly offline screen with a retry button.
  win.webContents.on('did-fail-load', (_e, code, _desc, failedUrl, isMain) => {
    if (isMain && code !== -3) win.loadFile(path.join(__dirname, 'offline.html'), { query: { url: failedUrl || APP_URL } });
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]) : null);
  // Camera, microphone, notifications and fullscreen are allowed for Clipzy only (needed for LIVE).
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    const fromApp = new URL(wc.getURL()).origin === ORIGIN;
    cb(fromApp && ['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'display-capture'].includes(permission));
  });
  // Screen sharing in LIVE Studio: share the primary screen (with system audio on Windows).
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => cb({ video: sources[0], audio: process.platform === 'win32' ? 'loopback' : undefined }));
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
