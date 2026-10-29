// settings.json in userData. Atomic writes: temp file then rename.
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // Library
  outputDir: '',            // filled with <Music>/Crate on first run
  folderTemplate: '',       // blank = no subfolders; artist/album live in the tags
  fileTemplate: '{title} - {artist}',
  skipExisting: true,
  extraLibraryDirs: [],     // also treat these folders as "already have it"
  // Audio
  bitrate: '320',           // 320 | 256 | 192 | V0
  normalise: false,         // ReplayGain tags only — audio is never altered
  // Metadata
  spotifyClientId: '',
  spotifyClientSecret: '',
  spotifyRefreshToken: '',  // from the user-login (PKCE) flow — unlocks playlists
  matchThreshold: 0.72,
  embedArt: true,
  artSize: '640',           // 640 | 300 | 64
  noMatchBehaviour: 'source', // source | blank | skip
  tagGenre: true,           // MusicBrainz genres, Spotify artist genres as fallback
  writeM3u: false,
  // Reliability
  concurrency: 2,
  retries: 3,
  retryBackoffMs: 2000,
  trackTimeoutSec: 300,
  resumeOnLaunch: true,
  // Tools
  ytdlpPath: '',
  ffmpegPath: '',
  autoUpdateYtdlp: true,    // stale extractors are the #1 cause of failures
  // Path to a cookies.txt exported from a signed-in YouTube session. Used
  // ONLY to retry a track that was refused as age-restricted, never for
  // ordinary downloads. Empty means no account is involved at all.
  youtubeCookiesFile: '',
  pythonPath: '',           // optional: the python that has spotdl installed
  limitRate: 'off',         // off | 1M | 2M | 5M
};

let file = null;
let current = { ...DEFAULTS };
const listeners = [];

function init(userDataPath, defaultMusicDir) {
  file = path.join(userDataPath, 'settings.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    current = { ...DEFAULTS, ...raw };
  } catch {
    current = { ...DEFAULTS };
  }
  if (!current.outputDir) current.outputDir = path.join(defaultMusicDir, 'Crate');
  save();
}

function save() {
  if (!file) return;
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
  fs.renameSync(tmp, file);
}

function get() { return { ...current }; }

function set(patch) {
  const clean = {};
  for (const k of Object.keys(patch || {})) {
    if (k in DEFAULTS) clean[k] = patch[k];
  }
  current = { ...current, ...clean };
  save();
  for (const fn of listeners) { try { fn(get(), clean); } catch { /* ignore */ } }
  return get();
}

function onChange(fn) { listeners.push(fn); }

module.exports = { init, get, set, onChange, DEFAULTS };
