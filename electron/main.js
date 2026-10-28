// Crate — main process. Window, settings store, manifest, engine, IPC.
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');

const settings = require('./settings');
const manifest = require('./manifest');
const spotify = require('./spotify');
const genre = require('./genre');
const library = require('./library');
const playlists = require('./playlists');
const tools = require('./tools');
const engine = require('./engine');
const expand = require('./expand');
const { RateLimiter, CircuitBreaker } = require('./politeness');

const limiter = new RateLimiter({
  ratePerSec: 1,
  burst: 2,
  hosts: {
    'api.spotify.com': { ratePerSec: 4, burst: 5 },   // generous official quota
    'i.scdn.co': { ratePerSec: 4, burst: 5 },          // art CDN
    'musicbrainz.org': { ratePerSec: 1, burst: 1 },    // MB's stated limit — strict
  },
});
const breaker = new CircuitBreaker();

let win = null;
let expandBusy = false;

if (!app.requestSingleInstanceLock()) app.quit();

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 860,
    minHeight: 540,
    frame: false,
    backgroundColor: '#101114',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => broadcast('win:state', { maximized: true }));
  win.on('unmaximize', () => broadcast('win:state', { maximized: false }));
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  const cacheDir = path.join(userData, 'cache');

  settings.init(userData, app.getPath('music'));
  manifest.init(userData);
  tools.init({ settings, appRoot: path.join(__dirname, '..') });
  spotify.init({ settings, limiter, breaker, cacheDir, tools });
  genre.init({ settings, spotify, limiter, breaker, cacheDir });
  library.init({ settings, cacheDir });
  playlists.init({ settings, spotify, library, userData });
  settings.onChange((_all, patch) => {
    if ('outputDir' in patch || 'extraLibraryDirs' in patch) library.invalidate();
  });

  manifest.onChange((type, payload) => {
    if (type === 'rows') broadcast('rows:changed', manifest.rows());
    else if (type === 'row') broadcast('row:changed', payload);
  });

  engine.init({
    manifest, settings, spotify, genre, tools, library, limiter, breaker, userData,
    emitStatus: (info) => broadcast('status', info),
  });

  // App died mid-download? Those rows go back to pending.
  const resumed = manifest.resetWorking();
  const s = settings.get();
  if (!s.resumeOnLaunch && (manifest.counts().pending > 0)) {
    engine.setPaused(true); // queue is intact; user presses resume
  }
  if (resumed > 0) broadcast('rows:changed', manifest.rows());

  createWindow();
  keepYtdlpFresh();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Extractors break whenever YouTube changes, and a stale binary fails every
// download with a confusing 403 that looks like blocking. Check on launch and
// (unless switched off) update in the background before the user hits it.
async function keepYtdlpFresh() {
  try {
    const info = await tools.ytdlpInfo(true);
    if (!info) {
      broadcast('notice', { text: 'yt-dlp is not installed — download it in Settings › Tools', kind: 'error' });
      return;
    }
    const latest = await tools.latestYtdlpVersion();
    if (!latest || latest === info.version) return;

    if (!settings.get().autoUpdateYtdlp) {
      broadcast('notice', { text: `yt-dlp ${latest} is available (you have ${info.version}). Old versions fail downloads with 403 errors — update in Settings › Tools.`, kind: 'error' });
      return;
    }
    broadcast('notice', { text: `Updating yt-dlp to ${latest}…`, kind: 'info' });
    const fresh = await tools.downloadYtdlp();
    broadcast('notice', { text: `yt-dlp updated to ${(fresh && fresh.version) || latest}.`, kind: 'info' });
  } catch (err) {
    broadcast('notice', { text: `Couldn't check for a yt-dlp update: ${err.message}`, kind: 'error' });
  }
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.on('before-quit', () => {
  tools.killAll();
  manifest.saveNow();
});

app.on('window-all-closed', () => {
  app.quit();
});

// ---------- IPC ----------

// Accepts anything pasted: one link, many links, or the block of track links
// Spotify's own apps produce when you select a whole playlist and copy. That
// last route is how a playlist of any size gets in — Spotify does the
// listing, which its API will not do for this app.
ipcMain.handle('link:expand', async (_e, text) => {
  if (expandBusy) return { ok: false, error: 'Still reading the previous paste — one moment' };
  expandBusy = true;
  const ctx = {
    spotify, tools, limiter, settings, library,
    onProgress: (t) => broadcast('notice', { text: t, kind: 'info' }),
  };
  try {
    const raw = String(text || '');
    const trackIds = expand.trackIdsFromText(raw);
    const others = expand.otherLinksFromText(raw);
    if (!trackIds.length && !others.length) {
      return { ok: false, error: "That doesn't look like a link — paste a track, album or playlist URL" };
    }

    const parts = [];
    const errors = [];
    if (trackIds.length) {
      try {
        const built = await expand.expandTrackIds(trackIds, ctx);
        parts.push(await expand.expandLink('pasted tracks', ctx, built));
      } catch (err) {
        errors.push(err.message || 'Could not read the pasted tracks');
      }
    }
    for (const u of others) {
      try {
        parts.push(await expand.expandLink(u, ctx));
      } catch (err) {
        errors.push(err.message || 'Could not read that link');
      }
    }
    engine.notify();

    if (!parts.length) return { ok: false, error: errors[0] || 'Could not read that link' };
    const sum = (k) => parts.reduce((a, p) => a + (p[k] || 0), 0);
    return {
      ok: true,
      titles: parts.map((p) => p.title),
      title: parts.length === 1 ? parts[0].title : `${parts.length} links`,
      added: sum('added'),
      alreadyHave: sum('alreadyHave'),
      toDownload: sum('toDownload'),
      unavailable: sum('unavailable'),
      warning: parts.map((p) => p.warning).filter(Boolean)[0] || null,
      errors,
    };
  } catch (err) {
    return { ok: false, error: err.message || 'Could not read that link' };
  } finally {
    expandBusy = false;
  }
});

// ---------- watched playlists ----------
// Captured once, checked when asked, downloaded only when asked. Nothing
// here runs on a timer.

ipcMain.handle('playlists:list', () => playlists.list());
ipcMain.handle('playlists:rename', (_e, { id, name, folder, sourceUrl }) => playlists.rename(id, name, folder, sourceUrl));
ipcMain.handle('playlists:remove', (_e, id) => playlists.remove(id));
ipcMain.handle('playlists:set-compare', (_e, { id, dirs }) => playlists.setCompareDirs(id, dirs));

// Reads a Spotify playlist or album link into the release metadata Crate
// stores. Returns null when the text holds no such link.
async function tracksFromLink(text) {
  const link = expand.otherLinksFromText(text).find((u) => {
    const c = expand.classify(u);
    return c.kind === 'spotify-playlist' || c.kind === 'spotify-album';
  });
  if (!link) return null;
  const c = expand.classify(link);
  const artSize = settings.get().artSize;
  const { metaFromTrack } = require('./matcher');

  if (c.kind === 'spotify-album') {
    const { album, tracks } = await spotify.getAlbum(c.id);
    return {
      link,
      name: album.name || 'Spotify album',
      metas: tracks.filter(Boolean).map((t) => metaFromTrack(t, artSize)),
      capped: false,
    };
  }
  const pl = await spotify.getPlaylist(c.id);
  // Playlists can hold the owner's own local files. They carry a name but no
  // Spotify id, are not downloadable from anywhere, and would otherwise sit
  // in the list as permanently "missing" — so they are reported, not kept.
  const playable = [];
  let localFiles = 0;
  for (const item of pl.items) {
    if (!item || !item.track) continue;
    if (item.is_local || !item.track.id) { localFiles += 1; continue; }
    playable.push(metaFromTrack(item.track, artSize));
  }
  return {
    link,
    name: pl.name || 'Spotify playlist',
    metas: playable,
    localFiles,
    capped: Boolean(pl.embedCapped),
  };
}

ipcMain.handle('playlists:add', async (_e, { name, folder, text }) => {
  try {
    // A playlist link is the quick way in; a pasted block of track links is
    // the way past Spotify's 100-track ceiling for this app.
    const fromLink = await tracksFromLink(text || '');
    if (fromLink) {
      if (!fromLink.metas.length) return { ok: false, error: 'That link held no readable tracks' };
      const p = await playlists.add({
        name: name || fromLink.name, folder, metas: fromLink.metas, sourceUrl: fromLink.link,
      });
      return {
        ok: true, playlist: p, captured: fromLink.metas.length,
        localFiles: fromLink.localFiles || 0, capped: fromLink.capped,
      };
    }
    const ids = expand.trackIdsFromText(text || '');
    if (!ids.length) return { ok: false, error: 'Paste a Spotify playlist link, or the copied track links' };
    const p = await playlists.add({ name, folder, trackIds: ids }, (done, total) =>
      broadcast('notice', { text: `Reading track ${done} of ${total} from Spotify...`, kind: 'info' }));
    return { ok: true, playlist: p, captured: ids.length, capped: false };
  } catch (err) {
    return { ok: false, error: err.message || 'Could not capture that playlist' };
  }
});

// With no pasted text, a playlist captured from a link re-reads that link.
ipcMain.handle('playlists:update', async (_e, { id, text }) => {
  try {
    const existing = playlists.get(id);
    if (!existing) return { ok: false, error: 'That playlist is no longer here' };
    const source = (text && text.trim()) ? text : (existing.sourceUrl || '');

    const fromLink = await tracksFromLink(source);
    if (fromLink) {
      const p = await playlists.updateTracks(
        id, fromLink.metas.map((m) => m.spotifyId), null, fromLink.metas);
      return { ok: true, playlist: p, localFiles: fromLink.localFiles || 0, capped: fromLink.capped };
    }
    const ids = expand.trackIdsFromText(source);
    if (!ids.length) return { ok: false, error: 'Paste a playlist link or the copied track links' };
    const p = await playlists.updateTracks(id, ids, (done, total) =>
      broadcast('notice', { text: `Reading track ${done} of ${total} from Spotify...`, kind: 'info' }));
    return { ok: true, playlist: p, capped: false };
  } catch (err) {
    return { ok: false, error: err.message || 'Could not update that playlist' };
  }
});

ipcMain.handle('playlists:check', async (_e, id) => {
  try {
    broadcast('notice', { text: 'Checking the folder...', kind: 'info' });
    const r = await playlists.check(id, (done, total) =>
      broadcast('notice', { text: `Reading your library: ${done} of ${total} files...`, kind: 'info' }));
    if (!r) return { ok: false, error: 'That playlist is no longer here' };
    const { missingTracks, ...rest } = r;
    return { ok: true, playlist: rest };
  } catch (err) {
    return { ok: false, error: err.message || 'Could not check that playlist' };
  }
});

// Queues what the folder is missing. Rows carry their playlist's folder, so
// several watched playlists can download into different places at once.
ipcMain.handle('playlists:download-new', async (_e, id) => {
  try {
    const r = await playlists.check(id, (done, total) =>
      broadcast('notice', { text: `Reading your library: ${done} of ${total} files...`, kind: 'info' }));
    if (!r) return { ok: false, error: 'That playlist is no longer here' };
    const p = playlists.get(id);

    const queued = new Set();
    for (const row of manifest.rows()) {
      if (row.status === 'failed') continue;
      if (row.meta && row.meta.spotifyId) queued.add(row.meta.spotifyId);
    }
    const fresh = r.missingTracks.filter((m) => !m.spotifyId || !queued.has(m.spotifyId));
    if (!fresh.length) {
      return { ok: true, added: 0, alreadyQueued: r.missingTracks.length, playlist: { ...r, missingTracks: undefined } };
    }

    const rows = fresh.map((meta) => manifest.makeRow({
      sourceKind: 'spotify',
      sourceTitle: `${meta.artist} — ${meta.title}`,
      sourceDurationSec: meta.durationMs ? Math.round(meta.durationMs / 1000) : null,
      needsResolve: true,
      meta,
      matched: true,
      matchMode: 'matched',
      destDir: p.folder,
    }));
    manifest.addBatch({ title: p.name, sourceUrl: null, expected: rows.length }, rows);
    manifest.saveNow();
    engine.notify();
    return {
      ok: true,
      added: rows.length,
      alreadyQueued: r.missingTracks.length - rows.length,
      playlist: { ...r, missingTracks: undefined },
    };
  } catch (err) {
    return { ok: false, error: err.message || 'Could not queue those tracks' };
  }
});

ipcMain.handle('queue:get', () => ({ rows: manifest.rows(), status: engine.statusInfo() }));
ipcMain.handle('queue:start', () => { const n = manifest.startLoaded(); engine.notify(); return n; });
ipcMain.handle('queue:retry-row', (_e, id) => { manifest.retryRow(id); engine.notify(); });
ipcMain.handle('queue:retry-failed', () => { const n = manifest.retryFailed(); engine.notify(); return n; });
ipcMain.handle('queue:remove-row', (_e, id) => manifest.removeRow(id));
ipcMain.handle('queue:clear-finished', () => manifest.clearFinished());

ipcMain.handle('queue:cancel-all', () => engine.cancelAll());
ipcMain.handle('engine:set-paused', (_e, v) => { engine.setPaused(v); return engine.isPaused(); });

ipcMain.handle('settings:get', () => settings.get());
ipcMain.handle('settings:set', (_e, patch) => {
  const out = settings.set(patch);
  engine.notify();
  return out;
});
ipcMain.handle('settings:choose-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('spotify:status', () => ({ connected: spotify.isConnected() }));
ipcMain.handle('spotify:connect', async () => {
  try {
    await spotify.connectAccount((url) => shell.openExternal(url));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('spotify:disconnect', () => { spotify.disconnect(); return { ok: true }; });

ipcMain.handle('tools:check', async () => {
  const ytdlp = await tools.ytdlpInfo(true);
  let updateAvailable = null;
  if (ytdlp) {
    const latest = await tools.latestYtdlpVersion();
    if (latest && latest !== ytdlp.version) updateAvailable = latest;
  }
  let ffmpeg = null;
  try { ffmpeg = tools.ffmpegPath(); } catch { /* none */ }
  return { ytdlp, ffmpeg, updateAvailable };
});
ipcMain.handle('tools:update-ytdlp', async () => {
  try { return { ok: true, ...(await tools.updateYtdlp()) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('tools:download-ytdlp', async () => {
  try {
    const info = await tools.downloadYtdlp();
    return { ok: true, version: info && info.version };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('shell:show-item', (_e, p) => { if (p) shell.showItemInFolder(p); });
ipcMain.handle('shell:open-path', (_e, p) => { if (p) shell.openPath(p); });

ipcMain.handle('win:control', (_e, action) => {
  if (!win) return;
  if (action === 'min') win.minimize();
  else if (action === 'max') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
  else if (action === 'close') win.close();
});
