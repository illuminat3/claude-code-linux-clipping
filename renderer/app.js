'use strict';

// ── Utilities ──────────────────────────────────────────────────────────────────

function fmt(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ── Navigation ─────────────────────────────────────────────────────────────────

const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page');

function showPage(pageId) {
  pages.forEach(p => p.classList.toggle('active', p.id === `page-${pageId}`));
  navItems.forEach(n => n.classList.toggle('active', n.dataset.page === pageId));
}

navItems.forEach(item => {
  item.addEventListener('click', () => {
    showPage(item.dataset.page);
    if (item.dataset.page === 'recording') refreshRecordingPreview();
    if (item.dataset.page === 'clips') loadClips();
  });
});

// ── Window controls ────────────────────────────────────────────────────────────

document.getElementById('btn-minimize').addEventListener('click', () => window.api.window.minimize());
document.getElementById('btn-maximize').addEventListener('click', () => window.api.window.maximize());
document.getElementById('btn-close').addEventListener('click',    () => window.api.window.close());

// ── Recording page ─────────────────────────────────────────────────────────────

let recStatus = { recording: false, segments: 0, maxSegments: 0 };

const btnRecToggle    = document.getElementById('btn-rec-toggle');
const recToggleIcon   = document.getElementById('rec-toggle-icon');
const recToggleLabel  = document.getElementById('rec-toggle-label');
const recStatusValue  = document.getElementById('rec-status-value');
const bufferBar       = document.getElementById('buffer-bar');
const bufferLabel     = document.getElementById('buffer-label');
const btnSaveClip     = document.getElementById('btn-save-clip');
const recNotification = document.getElementById('rec-notification');
const sidebarRecDot   = document.getElementById('sidebar-rec-dot');
const sidebarStatusDot   = document.getElementById('sidebar-status-dot');
const sidebarStatusLabel = document.getElementById('sidebar-status-label');

function applyRecStatus(status) {
  if (!status) return;
  recStatus = status;

  const isRec = status.isRecording;

  // Toggle button
  recToggleIcon.textContent  = isRec ? '\u23F9' : '\u25B6';
  recToggleLabel.textContent = isRec ? 'Stop Recording' : 'Start Recording';
  btnRecToggle.classList.toggle('recording', isRec);

  // Status text
  recStatusValue.textContent = isRec ? 'Recording' : 'Stopped';
  recStatusValue.style.color = isRec ? 'var(--error)' : 'var(--text-muted)';

  // Buffer bar
  const segs    = status.segmentCount || 0;
  const maxSegs = status.maxSegments  || 0;
  const pct     = maxSegs > 0 ? Math.min(100, (segs / maxSegs) * 100) : 0;
  bufferBar.style.width  = `${pct}%`;
  bufferLabel.textContent = `${segs} / ${maxSegs} segments`;

  // Save clip button
  btnSaveClip.disabled = !isRec && segs === 0;

  // Sidebar
  sidebarStatusDot.classList.toggle('recording', isRec);
  sidebarStatusLabel.textContent = isRec ? 'Recording' : 'Stopped';
  sidebarRecDot.classList.toggle('active', isRec);
}

btnRecToggle.addEventListener('click', async () => {
  if (recStatus.recording) {
    btnRecToggle.disabled = true;
    const res = await window.api.recorder.stop();
    btnRecToggle.disabled = false;
    if (!res.ok) showRecNotification(res.error || 'Failed to stop recording', 'error');
  } else {
    btnRecToggle.disabled = true;
    const res = await window.api.recorder.start();
    btnRecToggle.disabled = false;
    if (!res.ok) showRecNotification(res.error || 'Failed to start recording', 'error');
  }
});

btnSaveClip.addEventListener('click', async () => {
  btnSaveClip.disabled = true;
  showRecNotification('Saving clip\u2026', 'info');
  await window.api.recorder.saveClip();
  // Result comes via 'clip:saved' or 'clip:error' events
});

function showRecNotification(msg, type = 'info') {
  recNotification.textContent = msg;
  recNotification.className = `rec-notification ${type}`;
  recNotification.classList.remove('hidden');
  clearTimeout(recNotification._timer);
  recNotification._timer = setTimeout(() => {
    recNotification.classList.add('hidden');
  }, 4000);
}

async function refreshRecordingPreview() {
  const cfg = await window.api.config.get();
  const grid = document.getElementById('rec-preview-grid');
  grid.innerHTML = '';
  const items = [
    ['Clip Duration', `${cfg.clipDuration || 180}s`],
    ['FPS',          cfg.fps        || 30],
    ['Quality (CRF)',cfg.videoCrf   || 23],
    ['Codec',        cfg.videoCodec || 'libx264'],
    ['Audio',        cfg.captureAudio ? 'On' : 'Off'],
    ['Hotkey',       cfg.hotkey     || 'F9'],
  ];
  items.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'preview-item';
    row.innerHTML = `<div class="preview-key">${label}</div><div class="preview-val">${value}</div>`;
    grid.appendChild(row);
  });
}

// Recorder IPC events
window.api.on('recorder:status', (status) => applyRecStatus(status));
window.api.on('recorder:error',  (msg)    => showRecNotification(msg, 'error'));

window.api.on('clip:saving', () => {
  showRecNotification('Saving clip\u2026', 'info');
});

window.api.on('clip:saved', (clip) => {
  btnSaveClip.disabled = false;
  showRecNotification(`Clip saved: ${clip.filename}`, 'success');
  // Refresh clips list if visible
  if (document.getElementById('page-clips').classList.contains('active')) {
    loadClips();
  }
});

window.api.on('clip:error', (msg) => {
  btnSaveClip.disabled = false;
  showRecNotification(msg || 'Failed to save clip', 'error');
});

// ── Clips page ─────────────────────────────────────────────────────────────────

const clipsGrid    = document.getElementById('clips-grid');
const clipsEmpty   = document.getElementById('clips-empty');
const clipsLoading = document.getElementById('clips-loading');

document.getElementById('btn-open-folder').addEventListener('click', () => {
  window.api.clips.openFolder();
});

let allClips = [];

async function loadClips() {
  clipsLoading.classList.remove('hidden');
  clipsEmpty.classList.add('hidden');
  clipsGrid.innerHTML = '';

  try {
    allClips = await window.api.clips.list();
  } catch (e) {
    allClips = [];
  }

  clipsLoading.classList.add('hidden');

  if (allClips.length === 0) {
    // Update hotkey hint
    const hotkey = await window.api.config.get('hotkey').catch(() => 'F9');
    document.getElementById('empty-hotkey').textContent = hotkey || 'F9';
    clipsEmpty.classList.remove('hidden');
    return;
  }

  allClips.forEach(clip => clipsGrid.appendChild(buildClipCard(clip)));
}

function buildClipCard(clip) {
  const card = document.createElement('div');
  card.className = 'clip-card';
  card.dataset.id = clip.id;

  const thumbSrc = clip.thumbPath ? window.api.pathToFileUrl(clip.thumbPath) : null;

  card.innerHTML = `
    <div class="clip-thumb-wrap">
      ${thumbSrc
        ? `<img class="clip-thumb" src="${thumbSrc}" alt="thumbnail" />`
        : `<div class="clip-no-thumb">\uD83C\uDFA5</div>`}
      <div class="clip-play-overlay">
        <button class="clip-play-btn" title="Play">\u25B6</button>
      </div>
    </div>
    <div class="clip-info">
      <div class="clip-filename" title="${clip.filename}">${clip.filename}</div>
      <div class="clip-meta">
        <span class="clip-meta-item">\u23F1 ${fmt(clip.duration)}</span>
        <span class="clip-meta-item">\uD83D\uDCBE ${fmtSize(clip.size)}</span>
        <span class="clip-meta-item">${fmtDate(clip.createdAt)}</span>
      </div>
      <div class="clip-actions">
        <button class="btn btn-secondary btn-sm btn-trim" title="Trim clip">\u2702 Trim</button>
        <button class="btn btn-danger btn-sm btn-delete" title="Delete clip">\uD83D\uDDD1 Delete</button>
      </div>
    </div>
  `;

  card.querySelector('.clip-play-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openPlayer(clip);
  });

  card.querySelector('.clip-thumb-wrap').addEventListener('click', () => openPlayer(clip));

  card.querySelector('.btn-trim').addEventListener('click', (e) => {
    e.stopPropagation();
    openPlayer(clip, true);
  });

  card.querySelector('.btn-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    openDeleteModal(clip);
  });

  return card;
}

// ── Delete modal ───────────────────────────────────────────────────────────────

const deleteOverlay = document.getElementById('delete-overlay');
const deleteModalName = document.getElementById('delete-modal-name');
let pendingDeleteId = null;

function openDeleteModal(clip) {
  pendingDeleteId = clip.id;
  deleteModalName.textContent = clip.filename;
  deleteOverlay.classList.remove('hidden');
}

document.getElementById('btn-delete-cancel').addEventListener('click', () => {
  deleteOverlay.classList.add('hidden');
  pendingDeleteId = null;
});

document.getElementById('btn-delete-confirm').addEventListener('click', async () => {
  if (!pendingDeleteId) return;
  deleteOverlay.classList.add('hidden');
  const res = await window.api.clips.delete(pendingDeleteId);
  pendingDeleteId = null;
  if (res.ok) {
    loadClips();
  }
});

deleteOverlay.addEventListener('click', (e) => {
  if (e.target === deleteOverlay) {
    deleteOverlay.classList.add('hidden');
    pendingDeleteId = null;
  }
});

// ── Player / trim modal ────────────────────────────────────────────────────────

const playerOverlay   = document.getElementById('player-overlay');
const playerFilename  = document.getElementById('player-filename');
const playerVideo     = document.getElementById('player-video');
const btnPlayPause    = document.getElementById('btn-play-pause');
const playerTime      = document.getElementById('player-time');
const trimHighlight   = document.getElementById('trim-highlight');
const trimHandleLeft  = document.getElementById('trim-handle-left');
const trimHandleRight = document.getElementById('trim-handle-right');
const playhead        = document.getElementById('playhead');
const trimStartLabel  = document.getElementById('trim-start-label');
const trimEndLabel    = document.getElementById('trim-end-label');
const trimDurLabel    = document.getElementById('trim-dur-label');
const trimStatus      = document.getElementById('trim-status');
const btnResetTrim    = document.getElementById('btn-reset-trim');
const btnSaveTrim     = document.getElementById('btn-save-trim');

let currentClip  = null;
let trimStart    = 0;
let trimEnd      = 0;
let trimDragging = null;

function openPlayer(clip, focusTrim = false) {
  currentClip = clip;
  playerFilename.textContent = clip.filename;

  const videoUrl = window.api.pathToFileUrl(clip.path);
  playerVideo.src = videoUrl;
  playerVideo.load();

  trimStart = 0;
  trimEnd   = clip.duration || 0;
  updateTrimUI();

  trimStatus.classList.add('hidden');
  btnSaveTrim.disabled = false;

  playerOverlay.classList.remove('hidden');

  playerVideo.addEventListener('loadedmetadata', () => {
    trimEnd = playerVideo.duration;
    updateTrimUI();
  }, { once: true });
}

document.getElementById('btn-player-close').addEventListener('click', closePlayer);

playerOverlay.addEventListener('click', (e) => {
  if (e.target === playerOverlay) closePlayer();
});

function closePlayer() {
  playerVideo.pause();
  playerVideo.src = '';
  playerOverlay.classList.add('hidden');
  currentClip = null;
}

// Play / pause
btnPlayPause.addEventListener('click', () => {
  if (playerVideo.paused) {
    playerVideo.play();
  } else {
    playerVideo.pause();
  }
});

playerVideo.addEventListener('play',  () => { btnPlayPause.innerHTML = '\u23F8'; });
playerVideo.addEventListener('pause', () => { btnPlayPause.innerHTML = '\u25B6'; });
playerVideo.addEventListener('ended', () => { btnPlayPause.innerHTML = '\u25B6'; });

playerVideo.addEventListener('timeupdate', () => {
  playerTime.textContent = `${fmt(playerVideo.currentTime)} / ${fmt(playerVideo.duration)}`;

  const dur = playerVideo.duration;
  if (dur > 0) {
    const pct = (playerVideo.currentTime / dur) * 100;
    playhead.style.left = `${pct}%`;
  }
});

// Trim handles drag
function updateTrimUI() {
  const dur = playerVideo.duration || currentClip?.duration || 1;
  const leftPct  = (trimStart / dur) * 100;
  const rightPct = (trimEnd   / dur) * 100;

  trimHandleLeft.style.left  = `${leftPct}%`;
  trimHandleRight.style.left = `${rightPct}%`;
  trimHighlight.style.left   = `${leftPct}%`;
  trimHighlight.style.width  = `${rightPct - leftPct}%`;

  trimStartLabel.textContent = `${trimStart.toFixed(1)}s`;
  trimEndLabel.textContent   = `${trimEnd.toFixed(1)}s`;
  trimDurLabel.textContent   = `${(trimEnd - trimStart).toFixed(1)}s`;
}

function startTrimDrag(e, side) {
  e.preventDefault();
  trimDragging = side;

  function onMove(ev) {
    const timeline = document.getElementById('trim-timeline');
    const rect = timeline.getBoundingClientRect();
    const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const dur = playerVideo.duration || currentClip?.duration || 1;
    const t   = pct * dur;

    if (trimDragging === 'left') {
      trimStart = Math.min(t, trimEnd - 0.5);
      trimStart = Math.max(0, trimStart);
    } else {
      trimEnd = Math.max(t, trimStart + 0.5);
      trimEnd = Math.min(dur, trimEnd);
    }
    updateTrimUI();
  }

  function onUp() {
    trimDragging = null;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchmove', onMove);
  document.addEventListener('touchend', onUp);
}

trimHandleLeft.addEventListener('mousedown',  (e) => startTrimDrag(e, 'left'));
trimHandleRight.addEventListener('mousedown', (e) => startTrimDrag(e, 'right'));
trimHandleLeft.addEventListener('touchstart',  (e) => startTrimDrag(e, 'left'));
trimHandleRight.addEventListener('touchstart', (e) => startTrimDrag(e, 'right'));

btnResetTrim.addEventListener('click', () => {
  trimStart = 0;
  trimEnd   = playerVideo.duration || currentClip?.duration || 0;
  updateTrimUI();
});

btnSaveTrim.addEventListener('click', async () => {
  if (!currentClip) return;
  btnSaveTrim.disabled = true;
  trimStatus.textContent = 'Saving trimmed clip\u2026';
  trimStatus.className   = 'info';
  trimStatus.classList.remove('hidden');

  const res = await window.api.clips.trim(currentClip.id, trimStart, trimEnd);
  if (res.ok) {
    trimStatus.textContent = `Saved: ${res.clip.filename}`;
    trimStatus.className   = 'trim-success';
    loadClips();
    setTimeout(closePlayer, 1800);
  } else {
    trimStatus.textContent = res.error || 'Failed to trim clip';
    trimStatus.className   = 'trim-error';
    btnSaveTrim.disabled   = false;
  }
});

// ── Settings page ──────────────────────────────────────────────────────────────

const sClipDuration   = document.getElementById('s-clip-duration');
const clipDurationHint= document.getElementById('clip-duration-hint');
const sHotkey         = document.getElementById('s-hotkey');
const btnCaptureHotkey= document.getElementById('btn-capture-hotkey');
const sOutputDir      = document.getElementById('s-output-dir');
const btnBrowseDir    = document.getElementById('btn-browse-dir');
const sNotifications  = document.getElementById('s-notifications');
const sFps            = document.getElementById('s-fps');
const sCrf            = document.getElementById('s-crf');
const crfHint         = document.getElementById('crf-hint');
const sCodec          = document.getElementById('s-codec');
const sResolution     = document.getElementById('s-resolution');
const sVideoFormat    = document.getElementById('s-video-format');
const sVideoDevice    = document.getElementById('s-video-device');
const sCaptureAudio   = document.getElementById('s-capture-audio');
const sAudioFormat    = document.getElementById('s-audio-format');
const sAudioDevice    = document.getElementById('s-audio-device');
const rowAudioFormat  = document.getElementById('row-audio-format');
const rowAudioDevice  = document.getElementById('row-audio-device');
const btnSaveSettings = document.getElementById('btn-save-settings');
const settingsToast   = document.getElementById('settings-toast');

sClipDuration.addEventListener('input', () => {
  clipDurationHint.textContent = `${sClipDuration.value}s`;
});

sCrf.addEventListener('input', () => {
  crfHint.textContent = sCrf.value;
});

sCaptureAudio.addEventListener('change', () => {
  const show = sCaptureAudio.checked;
  rowAudioFormat.classList.toggle('hidden', !show);
  rowAudioDevice.classList.toggle('hidden', !show);
});

async function loadSettings() {
  const cfg = await window.api.config.get();

  sClipDuration.value      = cfg.clipDuration   || 180;
  clipDurationHint.textContent = `${sClipDuration.value}s`;

  sHotkey.value            = cfg.hotkey         || 'F9';
  sOutputDir.value         = cfg.outputDir      || '';
  sNotifications.checked   = cfg.notifications  !== false;

  sFps.value               = String(cfg.fps     || 30);
  sCrf.value               = cfg.videoCrf        || 23;
  crfHint.textContent      = sCrf.value;
  sCodec.value             = cfg.videoCodec     || 'libx264';
  sResolution.value        = cfg.resolution     || 'auto';
  sVideoFormat.value       = cfg.videoFormat    || '';
  sVideoDevice.value       = cfg.videoDevice    || '';

  sCaptureAudio.checked    = cfg.captureAudio   !== false;
  sAudioFormat.value       = cfg.audioFormat    || '';
  sAudioDevice.value       = cfg.audioDevice    || '';

  const showAudio = sCaptureAudio.checked;
  rowAudioFormat.classList.toggle('hidden', !showAudio);
  rowAudioDevice.classList.toggle('hidden', !showAudio);
}

// Hotkey capture
let capturingHotkey = false;

btnCaptureHotkey.addEventListener('click', () => {
  if (capturingHotkey) return;
  capturingHotkey = true;
  sHotkey.value = 'Press a key\u2026';
  sHotkey.focus();

  function onKey(e) {
    e.preventDefault();
    e.stopPropagation();
    // Build Electron accelerator string
    const parts = [];
    if (e.ctrlKey)  parts.push('Ctrl');
    if (e.metaKey)  parts.push('Super');
    if (e.altKey)   parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    const key = e.key;
    if (!['Control','Meta','Alt','Shift'].includes(key)) {
      // Normalize
      const normalized = key.length === 1 ? key.toUpperCase() : key;
      parts.push(normalized);
    }
    if (parts.length > 0 && !['Control','Meta','Alt','Shift'].includes(parts[parts.length - 1])) {
      sHotkey.value = parts.join('+');
    }
    capturingHotkey = false;
    document.removeEventListener('keydown', onKey, true);
  }

  document.addEventListener('keydown', onKey, true);
});

btnBrowseDir.addEventListener('click', async () => {
  const dir = await window.api.dialog.openDirectory();
  if (dir) sOutputDir.value = dir;
});

btnSaveSettings.addEventListener('click', async () => {
  const settings = {
    clipDuration:  parseInt(sClipDuration.value, 10),
    hotkey:        sHotkey.value,
    outputDir:     sOutputDir.value,
    notifications: sNotifications.checked,
    fps:           parseInt(sFps.value, 10),
    videoCrf:      parseInt(sCrf.value, 10),
    videoCodec:    sCodec.value,
    resolution:    sResolution.value,
    videoFormat:   sVideoFormat.value,
    videoDevice:   sVideoDevice.value,
    captureAudio:  sCaptureAudio.checked,
    audioFormat:   sAudioFormat.value,
    audioDevice:   sAudioDevice.value,
  };

  await window.api.config.set(settings);
  showSettingsToast('Settings saved', 'success');
});

function showSettingsToast(msg, type = 'success') {
  settingsToast.textContent = msg;
  settingsToast.className   = `toast ${type}`;
  settingsToast.classList.remove('hidden');
  clearTimeout(settingsToast._timer);
  settingsToast._timer = setTimeout(() => {
    settingsToast.classList.add('hidden');
  }, 3000);
}

// ── Init ───────────────────────────────────────────────────────────────────────

async function init() {
  // Load initial recorder status
  try {
    const status = await window.api.recorder.getStatus();
    applyRecStatus(status);
  } catch (_) {}

  // Load clips
  await loadClips();

  // Load settings
  await loadSettings();
}

init();
