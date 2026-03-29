'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CONFIG = {
  clipDuration: 180,
  fps: 30,
  videoCrf: 23,
  videoCodec: 'libx264',
  resolution: 'auto',
  captureAudio: true,
  videoFormat: process.platform === 'win32' ? 'gdigrab' : 'x11grab',
  videoDevice: process.platform === 'win32' ? 'desktop' : (process.env.DISPLAY || ':0.0') + '+0,0',
  audioFormat: process.platform === 'win32' ? 'dshow' : 'pulse',
  audioDevice: process.platform === 'win32' ? 'audio=Stereo Mix (Realtek High Definition Audio)' : 'default',
  outputDir: path.join(os.homedir(), 'Videos', 'ClipRecorder'),
  hotkey: 'F9',
  notifications: true,
};

class Config {
  constructor(configPath) {
    this.configPath = configPath;
    this.data = {};
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        const parsed = JSON.parse(raw);
        this.data = Object.assign({}, DEFAULT_CONFIG, parsed);
      } else {
        this.data = Object.assign({}, DEFAULT_CONFIG);
        this.save();
      }
    } catch (err) {
      console.error('Config load error:', err);
      this.data = Object.assign({}, DEFAULT_CONFIG);
    }
  }

  save() {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('Config save error:', err);
    }
  }

  get(key) {
    if (key === undefined) {
      return Object.assign({}, this.data);
    }
    return this.data[key];
  }

  set(key, value) {
    if (typeof key === 'object' && key !== null) {
      Object.assign(this.data, key);
    } else {
      this.data[key] = value;
    }
    this.save();
  }

  getAll() {
    return Object.assign({}, this.data);
  }
}

module.exports = Config;
