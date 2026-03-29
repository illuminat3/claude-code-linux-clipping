'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  dialog,
  shell,
  Notification,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const Config = require('./src/config');
const Recorder = require('./src/recorder');
const clipper = require('./src/clipper');

// ── Paths ─────────────────────────────────────────────────────────────────────
const userDataPath = app.getPath('userData');
const configPath = path.join(userDataPath, 'config.json');

// ── Globals ───────────────────────────────────────────────────────────────────
let mainWindow = null;
let config = null;
let recorder = null;
let clipsMetadata = []; // array of clip objects
let registeredHotkey = null;

// ── Bootstrap ─────────────────────────────────────────────────────────────────
function init() {
  config = new Config(configPath);

  // Ensure clips output directory exists
  const outputDir = config.get('outputDir');
  if (!fs.existsSync(outputDir)) {
    try { fs.mkdirSync(outputDir, { recursive: true }); } catch (e) {}
  }

  loadClipsMetadata();

  recorder = new Recorder();
  setupRecorderEvents();
}

// ── Clips metadata ────────────────────────────────────────────────────────────
function clipsMetaPath() {
  return path.join(config.get('outputDir'), 'clips.json');
}

function loadClipsMetadata() {
  const metaPath = clipsMetaPath();
  if (fs.existsSync(metaPath)) {
    try {
      clipsMetadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (e) {
      clipsMetadata = [];
    }
  } else {
    clipsMetadata = [];
  }
  // Validate: only keep clips whose files still exist
  clipsMetadata = clipsMetadata.filter(c => fs.existsSync(c.path));
  saveClipsMetadata();
}

function saveClipsMetadata() {
  const metaPath = clipsMetaPath();
  try {
    fs.writeFileSync(metaPath, JSON.stringify(clipsMetadata, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save clips metadata:', e);
  }
}

// ── Recorder events ───────────────────────────────────────────────────────────
function setupRecorderEvents() {
  recorder.on('started', () => {
    sendToRenderer('recorder:status', recorder.getStatus());
  });

  recorder.on('stopped', () => {
    sendToRenderer('recorder:status', recorder.getStatus());
  });

  recorder.on('segment', () => {
    sendToRenderer('recorder:status', recorder.getStatus());
  });

  recorder.on('error', (err) => {
    console.error('Recorder error:', err);
    sendToRenderer('recorder:error', err.message);
    sendToRenderer('recorder:status', recorder.getStatus());
  });

  recorder.on('log', (msg) => {
    // Uncomment for verbose logging:
    // console.log('[recorder]', msg);
  });
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ── Hotkey ────────────────────────────────────────────────────────────────────
function registerHotkey() {
  const hotkey = config.get('hotkey') || 'F9';

  if (registeredHotkey) {
    try { globalShortcut.unregister(registeredHotkey); } catch (e) {}
    registeredHotkey = null;
  }

  try {
    const ok = globalShortcut.register(hotkey, () => {
      saveClipNow();
    });
    if (ok) {
      registeredHotkey = hotkey;
      console.log(`Hotkey registered: ${hotkey}`);
    } else {
      console.warn(`Could not register hotkey: ${hotkey}`);
    }
  } catch (e) {
    console.error('Hotkey registration error:', e);
  }
}

// ── Clip saving ───────────────────────────────────────────────────────────────
async function saveClipNow() {
  const clipDuration = config.get('clipDuration') || 180;
  const segments = recorder.getRecentSegments(clipDuration);

  if (!segments || segments.length === 0) {
    sendToRenderer('clip:error', 'No recording buffer available. Start recording first.');
    return;
  }

  sendToRenderer('clip:saving', null);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const filename = `clip_${timestamp}.mp4`;
  const outputPath = path.join(config.get('outputDir'), filename);

  try {
    const { outputPath: savedPath, thumbPath } = await clipper.saveClip(segments, outputPath);

    // Get duration
    let duration = 0;
    try { duration = await clipper.getVideoDuration(savedPath); } catch (e) {}

    // Get file size
    let size = 0;
    try { size = fs.statSync(savedPath).size; } catch (e) {}

    const clipMeta = {
      id: `clip_${Date.now()}`,
      filename,
      path: savedPath,
      thumbPath: thumbPath || null,
      duration,
      size,
      createdAt: new Date().toISOString(),
    };

    clipsMetadata.unshift(clipMeta);
    saveClipsMetadata();

    sendToRenderer('clip:saved', clipMeta);

    if (config.get('notifications')) {
      try {
        new Notification({
          title: 'Clip Saved',
          body: `${filename} (${Math.round(duration)}s)`,
        }).show();
      } catch (e) {}
    }
  } catch (err) {
    console.error('Save clip error:', err);
    sendToRenderer('clip:error', err.message);
  }
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 560,
    backgroundColor: '#0d0d1a',
    titleBarStyle: 'hidden',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

// Recorder
ipcMain.handle('recorder:start', async () => {
  try {
    recorder.start(config.getAll());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('recorder:stop', async () => {
  try {
    await recorder.stop();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('recorder:getStatus', () => {
  return recorder.getStatus();
});

// Clip saving
ipcMain.handle('clip:save', async () => {
  await saveClipNow();
  return { ok: true };
});

// Clip trim
ipcMain.handle('clip:trim', async (_event, clipId, trimStart, trimEnd) => {
  const clip = clipsMetadata.find(c => c.id === clipId);
  if (!clip) return { ok: false, error: 'Clip not found' };

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const filename = `clip_${timestamp}_trimmed.mp4`;
  const outputPath = path.join(config.get('outputDir'), filename);

  try {
    const { outputPath: savedPath, thumbPath } = await clipper.trimClip(clip.path, outputPath, trimStart, trimEnd);

    let duration = 0;
    try { duration = await clipper.getVideoDuration(savedPath); } catch (e) {}

    let size = 0;
    try { size = fs.statSync(savedPath).size; } catch (e) {}

    const clipMeta = {
      id: `clip_${Date.now()}`,
      filename,
      path: savedPath,
      thumbPath: thumbPath || null,
      duration,
      size,
      createdAt: new Date().toISOString(),
    };

    clipsMetadata.unshift(clipMeta);
    saveClipsMetadata();
    sendToRenderer('clip:saved', clipMeta);

    return { ok: true, clip: clipMeta };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Clips list
ipcMain.handle('clips:list', () => {
  // Re-validate existence
  clipsMetadata = clipsMetadata.filter(c => fs.existsSync(c.path));
  saveClipsMetadata();
  return clipsMetadata;
});

// Delete clip
ipcMain.handle('clips:delete', (_event, clipId) => {
  const idx = clipsMetadata.findIndex(c => c.id === clipId);
  if (idx === -1) return { ok: false, error: 'Clip not found' };

  const clip = clipsMetadata[idx];
  try {
    if (fs.existsSync(clip.path)) fs.unlinkSync(clip.path);
    if (clip.thumbPath && fs.existsSync(clip.thumbPath)) fs.unlinkSync(clip.thumbPath);
  } catch (e) {}

  clipsMetadata.splice(idx, 1);
  saveClipsMetadata();
  return { ok: true };
});

// Open folder
ipcMain.handle('clips:openFolder', () => {
  shell.openPath(config.get('outputDir'));
  return { ok: true };
});

// Config
ipcMain.handle('config:get', (_event, key) => {
  return key ? config.get(key) : config.getAll();
});

ipcMain.handle('config:set', (_event, key, value) => {
  config.set(key, value);

  // Side effects
  if (key === 'hotkey' || (typeof key === 'object' && key.hotkey)) {
    registerHotkey();
  }

  if (key === 'outputDir' || (typeof key === 'object' && key.outputDir)) {
    const newDir = typeof key === 'object' ? key.outputDir : value;
    if (!fs.existsSync(newDir)) {
      try { fs.mkdirSync(newDir, { recursive: true }); } catch (e) {}
    }
    loadClipsMetadata();
  }

  return { ok: true };
});

// Dialog
ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Window controls (frameless window)
ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('window:maximize', () => {
  if (mainWindow) {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  }
});
ipcMain.handle('window:close', () => { if (mainWindow) mainWindow.hide(); });

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  init();
  createWindow();
  registerHotkey();
});

// Keep app running in background when window is closed (continue recording)
app.on('window-all-closed', (e) => {
  // Do not quit — allow background recording
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (recorder) {
    recorder.stop().catch(() => {});
    recorder.cleanup();
  }
});
