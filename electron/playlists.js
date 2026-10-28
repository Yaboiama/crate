// Watched playlists.
//
// Spotify refuses playlist listings to this app, so a playlist is captured
// once from a pasted block of track links and then kept. Each one points at
// its own folder, and checking it for new tracks needs no network at all —
// the release metadata is stored at capture time, so a check is just the
// stored list compared against what is on disk.
//
// Nothing downloads on its own. Checking and downloading are separate,
// deliberate actions.
'use strict';

const fs = require('fs');
const path = require('path');

let S = null; // { settings, spotify, library, cacheDir }
let file = null;
let data = { lists: [] };

function init(ctx) {
  S = ctx;
  file = path.join(S.userData, 'playlists.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && Array.isArray(raw.lists)) data = raw;
  } catch {
    data = { lists: [] };
  }
}

function save() {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file); // never leave a half-written file behind
  } catch { /* the store rebuilds from the next save */ }
}

function newId() {
  return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

// What the interface shows — never the whole track list.
function summary(p) {
  return {
    id: p.id,
    name: p.name,
    folder: p.folder,
    sourceUrl: p.sourceUrl || null,
    total: p.tracks.length,
    lastCheckedAt: p.lastCheckedAt || 0,
    lastResult: p.lastResult || null,
    addedAt: p.addedAt,
  };
}

function list() { return data.lists.map(summary); }

function get(id) { return data.lists.find((p) => p.id === id) || null; }

// Fetches release metadata once, so later checks are offline and instant.
async function resolveTracks(ids, onProgress) {
  const artSize = S.settings.get().artSize;
  const { metaFromTrack } = require('./matcher');
  const out = [];
  let done = 0;
  for (const id of ids) {
    try {
      const t = await S.spotify.getTrack(id);
      if (t && t.id) out.push(metaFromTrack(t, artSize));
    } catch (err) {
      if (err.kind === 'ratelimit' || err.kind === 'auth') throw err;
      // a track that cannot be read is simply not part of the list
    }
    done += 1;
    if (onProgress && (done % 10 === 0 || done === ids.length)) onProgress(done, ids.length);
  }
  return out;
}

// `metas` short-circuits the per-track lookup when the caller already has
// full release data — which it does when a playlist link was expanded.
async function add({ name, folder, trackIds, metas, sourceUrl }, onProgress) {
  const tracks = metas && metas.length ? metas : await resolveTracks(trackIds || [], onProgress);
  const p = {
    id: newId(),
    name: name || 'Playlist',
    folder: folder || S.settings.get().outputDir,
    sourceUrl: sourceUrl || null,
    tracks,
    addedAt: Date.now(),
    lastCheckedAt: 0,
    lastResult: null,
  };
  data.lists.push(p);
  save();
  return summary(p);
}

// Re-paste after the playlist changed on Spotify: new tracks are added, and
// tracks already captured keep their stored metadata rather than being
// fetched again.
async function updateTracks(id, trackIds, onProgress, metas) {
  const p = get(id);
  if (!p) return null;
  const known = new Map(p.tracks.map((t) => [t.spotifyId, t]));
  const fresh = trackIds.filter((x) => !known.has(x));
  const added = metas && metas.length
    ? metas.filter((m) => !known.has(m.spotifyId))
    : (fresh.length ? await resolveTracks(fresh, onProgress) : []);
  const order = new Map(trackIds.map((x, i) => [x, i]));
  p.tracks = [...p.tracks, ...added]
    .filter((t) => order.has(t.spotifyId))
    .sort((a, b) => order.get(a.spotifyId) - order.get(b.spotifyId));
  save();
  return { ...summary(p), addedCount: added.length };
}

function rename(id, name, folder, sourceUrl) {
  const p = get(id);
  if (!p) return null;
  if (name) p.name = name;
  if (folder) p.folder = folder;
  if (sourceUrl !== undefined) p.sourceUrl = sourceUrl;
  save();
  return summary(p);
}

function remove(id) {
  const i = data.lists.findIndex((p) => p.id === id);
  if (i === -1) return false;
  data.lists.splice(i, 1);
  save();
  return true;
}

// Compares the stored list against the playlist's own folder. No network.
async function check(id, onProgress) {
  const p = get(id);
  if (!p) return null;
  // The first look at a large folder has to read every file's tag; after
  // that it is cached against size and mtime and comes back instantly.
  const indexes = await S.library.ensureAll(
    [p.folder, ...(S.settings.get().extraLibraryDirs || [])], onProgress);
  const missing = [];
  let have = 0;
  for (const meta of p.tracks) {
    if (S.library.findAny(indexes, meta)) have += 1;
    else missing.push(meta);
  }
  p.lastCheckedAt = Date.now();
  p.lastResult = { total: p.tracks.length, have, missing: missing.length };
  save();
  return { ...summary(p), missingTracks: missing };
}

module.exports = { init, list, get, add, updateTracks, rename, remove, check, summary };
