'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let ffmpegPath;
try {
  const p = require('ffmpeg-static');
  // ffmpeg-static returns the expected path; verify the binary actually exists
  ffmpegPath = (p && require('fs').existsSync(p)) ? p : 'ffmpeg';
} catch (e) {
  ffmpegPath = 'ffmpeg';
}

class Recorder extends EventEmitter {
  constructor() {
    super();
    this.ffmpegProcess = null;
    this.segments = []; // { path, index, mtime }
    this.segmentDir = null;
    this.segmentPrefix = 'seg';
    this.pollInterval = null;
    this.isRecording = false;
    this.config = null;
    this.segmentDuration = 10; // seconds per segment
    this.nextSegmentIndex = 0;
    this.restartTimeout = null;
    this.stopping = false;
  }

  _getMaxSegments(clipDuration) {
    // Keep enough segments to cover clipDuration plus a bit of buffer
    return Math.ceil(clipDuration / this.segmentDuration) + 2;
  }

  _buildFFmpegArgs(config) {
    const args = [];
    const isWindows = process.platform === 'win32';

    // Input: video
    if (config.fps) {
      args.push('-framerate', String(config.fps));
    }

    if (config.resolution && config.resolution !== 'auto') {
      args.push('-video_size', config.resolution);
    }

    args.push('-f', config.videoFormat);

    // On Linux x11grab, device includes display+offset like :0.0+0,0
    args.push('-i', config.videoDevice);

    // Input: audio
    if (config.captureAudio) {
      args.push('-f', config.audioFormat);
      args.push('-i', config.audioDevice);
    }

    // Encoding
    args.push('-c:v', config.videoCodec || 'libx264');
    args.push('-crf', String(config.videoCrf || 23));
    args.push('-preset', 'ultrafast');
    args.push('-tune', 'zerolatency');

    if (config.captureAudio) {
      args.push('-c:a', 'aac');
      args.push('-b:a', '128k');
    }

    // Segment muxer
    const segPattern = path.join(this.segmentDir, `${this.segmentPrefix}_%05d.mp4`);
    args.push('-f', 'segment');
    args.push('-segment_time', String(this.segmentDuration));
    args.push('-segment_format', 'mp4');
    args.push('-reset_timestamps', '1');
    args.push('-strftime', '0');
    args.push(segPattern);

    return args;
  }

  start(config) {
    if (this.isRecording) {
      this.emit('error', new Error('Already recording'));
      return;
    }

    this.config = config;
    this.stopping = false;

    // Create a fresh temp directory for segments
    this.segmentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliprec-'));
    this.segments = [];
    this.nextSegmentIndex = 0;

    const args = this._buildFFmpegArgs(config);
    this.emit('log', `Starting FFmpeg: ${ffmpegPath} ${args.join(' ')}`);

    try {
      this.ffmpegProcess = spawn(ffmpegPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.emit('error', err);
      return;
    }

    this.isRecording = true;

    this.ffmpegProcess.stdout.on('data', (data) => {
      this.emit('log', data.toString());
    });

    this.ffmpegProcess.stderr.on('data', (data) => {
      this.emit('log', data.toString());
    });

    this.ffmpegProcess.on('exit', (code, signal) => {
      this.isRecording = false;
      if (this.stopping) {
        this._cleanup();
        this.emit('stopped');
      } else {
        // Unexpected exit — attempt auto-restart
        this.emit('error', new Error(`FFmpeg exited unexpectedly (code=${code}, signal=${signal})`));
        this._scheduleRestart();
      }
    });

    this.ffmpegProcess.on('error', (err) => {
      this.isRecording = false;
      this.emit('error', err);
      if (!this.stopping) {
        this._scheduleRestart();
      }
    });

    // Start polling for new segment files
    this.pollInterval = setInterval(() => this._pollSegments(config), 2000);

    this.emit('started');
  }

  _scheduleRestart() {
    if (this.stopping || !this.config) return;
    this.emit('log', 'Scheduling FFmpeg restart in 3 seconds...');
    this.restartTimeout = setTimeout(() => {
      if (!this.stopping && this.config) {
        this.emit('log', 'Auto-restarting FFmpeg...');
        this.start(this.config);
      }
    }, 3000);
  }

  _pollSegments(config) {
    if (!this.segmentDir || !fs.existsSync(this.segmentDir)) return;

    let files;
    try {
      files = fs.readdirSync(this.segmentDir)
        .filter(f => f.startsWith(this.segmentPrefix) && f.endsWith('.mp4'))
        .sort();
    } catch (e) {
      return;
    }

    if (files.length === 0) return;

    // All files except the last one are "complete" (FFmpeg is writing the last one)
    const completeFiles = files.slice(0, files.length - 1);

    for (const filename of completeFiles) {
      const fullPath = path.join(this.segmentDir, filename);
      // Check if we've already added this segment
      const alreadyAdded = this.segments.some(s => s.path === fullPath);
      if (!alreadyAdded) {
        const stat = fs.statSync(fullPath);
        const seg = { path: fullPath, index: this.nextSegmentIndex++, mtime: stat.mtimeMs };
        this.segments.push(seg);
        this.emit('segment', seg);
      }
    }

    // Prune old segments beyond the buffer limit
    const maxSegments = this._getMaxSegments(config.clipDuration || 180);
    while (this.segments.length > maxSegments) {
      const old = this.segments.shift();
      try {
        fs.unlinkSync(old.path);
      } catch (e) {
        // ignore
      }
    }
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.ffmpegProcess || !this.isRecording) {
        this.stopping = true;
        resolve();
        return;
      }

      this.stopping = true;

      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }

      if (this.restartTimeout) {
        clearTimeout(this.restartTimeout);
        this.restartTimeout = null;
      }

      const forceKillTimer = setTimeout(() => {
        if (this.ffmpegProcess) {
          this.ffmpegProcess.kill('SIGKILL');
        }
        resolve();
      }, 3000);

      this.ffmpegProcess.once('exit', () => {
        clearTimeout(forceKillTimer);
        resolve();
      });

      // Send 'q' to gracefully stop FFmpeg
      try {
        this.ffmpegProcess.stdin.write('q');
        this.ffmpegProcess.stdin.end();
      } catch (e) {
        this.ffmpegProcess.kill('SIGTERM');
      }
    });
  }

  _cleanup() {
    // Optionally clean up temp dir on stop
    // We leave segments alive so that a final clip can still be saved right after stopping
  }

  cleanup() {
    // Called on app quit — remove temp segment dir
    if (this.segmentDir && fs.existsSync(this.segmentDir)) {
      try {
        const files = fs.readdirSync(this.segmentDir);
        for (const f of files) {
          try { fs.unlinkSync(path.join(this.segmentDir, f)); } catch (e) {}
        }
        fs.rmdirSync(this.segmentDir);
      } catch (e) {}
    }
  }

  getRecentSegments(durationSeconds) {
    // Return segments that cover the last durationSeconds worth of recording
    const needed = Math.ceil(durationSeconds / this.segmentDuration);
    const start = Math.max(0, this.segments.length - needed);
    return this.segments.slice(start).map(s => ({ path: s.path, index: s.index }));
  }

  getStatus() {
    return {
      isRecording: this.isRecording,
      segmentCount: this.segments.length,
      maxSegments: this.config ? this._getMaxSegments(this.config.clipDuration || 180) : 0,
      segmentDir: this.segmentDir,
    };
  }
}

module.exports = Recorder;
