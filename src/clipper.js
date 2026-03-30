'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let ffmpegPath;
try {
  const p = require('ffmpeg-static');
  ffmpegPath = (p && require('fs').existsSync(p)) ? p : 'ffmpeg';
} catch (e) {
  ffmpegPath = 'ffmpeg';
}

// Try ffprobe from the companion package, fall back to system ffprobe
let ffprobePath = 'ffprobe';
try {
  const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
  ffprobePath = ffprobeInstaller.path;
} catch (e) {
  // Use system ffprobe
}

/**
 * Run FFmpeg and return a promise that resolves on exit code 0.
 */
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
    proc.on('error', reject);
  });
}

/**
 * Build a concat list file from an array of segment paths.
 * Returns path to the temp list file.
 */
function buildConcatList(segments) {
  const listPath = path.join(os.tmpdir(), `concat_${Date.now()}.txt`);
  const lines = segments.map(s => {
    // FFmpeg concat format: use forward slashes (works on all platforms) and
    // escape single quotes with backslash per the concat demuxer spec.
    const p = s.path.replace(/\\/g, '/').replace(/'/g, "\\'");
    return `file '${p}'`;
  }).join('\n');
  fs.writeFileSync(listPath, lines, 'utf8');
  return listPath;
}

/**
 * Save a clip from a set of segments.
 * trimStart/trimEnd are optional seconds into the final concatenated clip.
 */
async function saveClip(segments, outputPath, trimStart = null, trimEnd = null) {
  if (!segments || segments.length === 0) {
    throw new Error('No segments to save');
  }

  // Ensure output directory exists
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const listPath = buildConcatList(segments);

  try {
    if (trimStart !== null || trimEnd !== null) {
      // With trim: we still concat first to a temp file then trim
      const tempPath = outputPath.replace('.mp4', '_raw.mp4');
      await runFFmpeg([
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        tempPath,
      ]);

      await runFFmpeg([
        '-i', tempPath,
        ...(trimStart !== null && trimStart > 0 ? ['-ss', String(trimStart)] : []),
        ...(trimEnd !== null ? ['-to', String(trimEnd)] : []),
        '-c', 'copy',
        '-movflags', '+faststart',
        outputPath,
      ]);

      try { fs.unlinkSync(tempPath); } catch (e) {}
    } else {
      await runFFmpeg([
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        outputPath,
      ]);
    }
  } finally {
    try { fs.unlinkSync(listPath); } catch (e) {}
  }

  // Generate thumbnail
  const thumbPath = await generateThumbnail(outputPath);
  return { outputPath, thumbPath };
}

/**
 * Generate a thumbnail for a video file.
 * Returns the path to the thumbnail.
 */
async function generateThumbnail(videoPath) {
  const thumbPath = videoPath.replace(/\.mp4$/i, '_thumb.jpg');
  try {
    await runFFmpeg([
      '-ss', '1',
      '-i', videoPath,
      '-vframes', '1',
      '-vf', 'scale=320:-2',
      '-q:v', '3',
      '-y',
      thumbPath,
    ]);
  } catch (e) {
    // Try at position 0 if 1s fails (very short clip)
    try {
      await runFFmpeg([
        '-i', videoPath,
        '-vframes', '1',
        '-vf', 'scale=320:-2',
        '-q:v', '3',
        '-y',
        thumbPath,
      ]);
    } catch (e2) {
      return null;
    }
  }
  return thumbPath;
}

/**
 * Get video duration in seconds using ffprobe.
 */
function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    execFile(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ], (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`ffprobe error: ${stderr}`));
        return;
      }
      const duration = parseFloat(stdout.trim());
      if (isNaN(duration)) {
        reject(new Error('Could not parse duration'));
      } else {
        resolve(duration);
      }
    });
  });
}

/**
 * Trim an existing clip file and save to outputPath.
 */
async function trimClip(clipPath, outputPath, trimStart, trimEnd) {
  if (!fs.existsSync(clipPath)) {
    throw new Error(`Clip not found: ${clipPath}`);
  }

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const args = ['-i', clipPath];
  if (trimStart != null && trimStart > 0) {
    args.push('-ss', String(trimStart));
  }
  if (trimEnd != null) {
    args.push('-to', String(trimEnd));
  }
  args.push('-c', 'copy', '-movflags', '+faststart', '-y', outputPath);

  await runFFmpeg(args);

  const thumbPath = await generateThumbnail(outputPath);
  return { outputPath, thumbPath };
}

module.exports = { saveClip, generateThumbnail, getVideoDuration, trimClip };
