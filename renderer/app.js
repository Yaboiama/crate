// Crate renderer — queue rendering, live updates, settings binding.
// Vanilla JS, no framework, no build step.
'use strict';

const api = window.crate;

const $ = (id) => document.getElementById(id);
const rowsHost = $('rows');
const emptyState = $('emptyState');
const rowEls = new Map(); // id -> element

const ART_PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">' +
  '<rect width="40" height="40" rx="5" fill="#17181d"/>' +
  '<circle cx="20" cy="20" r="9" fill="none" stroke="#26282f" stroke-width="2"/>' +
  '<circle cx="20" cy="20" r="2.5" fill="#26282f"/></svg>'
);

const STAGE_LABELS = {
  start: 'Starting',
  resolve: 'Finding audio',
  match: 'Matching on Spotify',
  download: 'Downloading',
  convert: 'Converting',
  art: 'Fetching cover',
  genre: 'Finding genre',
  tag: 'Writing tags',
  place: 'Filing',
};

// ---------- row rendering ----------

function toFileUrl(p) {
  if (!p) return null;
  return 'file:///' + String(p).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');
}

function rowStateText(row) {
  if (row.status === 'working') {
    const label = STAGE_LABELS[row.stage] || 'Working';
    if (row.stage === 'download' && row.progress > 0) return `${label} ${Math.round(row.progress * 100)}%`;
    return label;
  }
  if (row.status === 'loaded') return 'Loaded';
  if (row.status === 'pending') {
    if (row.note) return row.note;
    if (row.nextAttemptAt && row.nextAttemptAt > Date.now()) {
      return `Retrying in ${Math.max(1, Math.round((row.nextAttemptAt - Date.now()) / 1000))}s`;
    }
    return 'Queued';
  }
  if (row.status === 'done') return row.tagged ? 'Done' : 'Done — tagged from source, not matched';
  if (row.status === 'skipped') return row.note || 'Already in library';
  if (row.status === 'failed') return row.error || 'Failed';
  return row.status;
}

function makeRowEl(row) {
  const el = document.createElement('div');
  el.className = 'row';
  el.dataset.id = row.id;

  const art = document.createElement('img');
  art.className = 'art';
  art.src = ART_PLACEHOLDER;
  art.alt = '';

  const main = document.createElement('div');
  main.className = 'cell-main';
  const t1 = document.createElement('div');
  t1.className = 't1';
  const t2 = document.createElement('div');
  t2.className = 't2';
  main.append(t1, t2);

  const albumCell = document.createElement('div');
  albumCell.className = 'cell-album';

  const state = document.createElement('div');
  state.className = 'cell-state';
  const stage = document.createElement('div');
  stage.className = 'stage';
  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('i');
  bar.append(fill);
  state.append(stage, bar);

  const actions = document.createElement('div');
  actions.className = 'cell-actions';
  const btnRetry = rowBtn('↻', 'Retry this track', () => api.retryRow(row.id));
  const btnShow = rowBtn('↗', 'Show in folder', () => {
    const r = currentRows.get(el.dataset.id);
    if (r && r.filePath) api.showItem(r.filePath);
  });
  const btnRemove = rowBtn('✕', 'Remove from list', () => api.removeRow(row.id));
  actions.append(btnRetry, btnShow, btnRemove);

  el.append(art, main, albumCell, state, actions);
  el._parts = { art, t1, t2, albumCell, stage, fill, btnRetry, btnShow, btnRemove };
  return el;
}

function rowBtn(glyph, title, onClick) {
  const b = document.createElement('button');
  b.className = 'row-btn';
  b.title = title;
  b.textContent = glyph;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function updateRowEl(el, row) {
  const p = el._parts;
  el.className = `row st-${row.status}` + (row.status !== 'pending' && !row.tagged ? ' untagged' : '');

  const m = row.meta;
  p.t1.textContent = (m && m.title) || row.sourceTitle || row.sourceUrl || 'Unknown';
  p.t1.title = p.t1.textContent;
  p.t2.textContent = (m && m.artist) || row.sourceUploader || '';
  const albumBits = [];
  if (m && m.album) albumBits.push(m.album);
  if (m && m.year) albumBits.push(m.year);
  if (row.genre) albumBits.push(row.genre);
  p.albumCell.textContent = albumBits.join(' · ');
  p.albumCell.title = p.albumCell.textContent;

  const artSrc = toFileUrl(row.artPath) || row.sourceThumb || null;
  const want = artSrc || ART_PLACEHOLDER;
  if (p.art.getAttribute('src') !== want) p.art.src = want;

  p.stage.textContent = rowStateText(row);
  p.stage.title = p.stage.textContent;
  p.fill.style.width = row.status === 'working' ? `${Math.round((row.progress || 0) * 100)}%` : '0%';

  p.btnRetry.hidden = row.status !== 'failed' && row.status !== 'skipped';
  p.btnShow.hidden = !(row.status === 'done' || row.status === 'skipped');
  p.btnRemove.hidden = row.status === 'working';
}

const currentRows = new Map();

function renderAll(rows) {
  currentRows.clear();
  for (const r of rows) currentRows.set(r.id, r);

  const seen = new Set();
  let prev = null;
  for (const row of rows) {
    seen.add(row.id);
    let el = rowEls.get(row.id);
    if (!el) {
      el = makeRowEl(row);
      rowEls.set(row.id, el);
    }
    if (prev) { if (prev.nextSibling !== el) prev.after(el); }
    else if (rowsHost.firstChild !== el) rowsHost.prepend(el);
    updateRowEl(el, row);
    prev = el;
  }
  for (const [id, el] of rowEls) {
    if (!seen.has(id)) { el.remove(); rowEls.delete(id); }
  }
  emptyState.hidden = rows.length > 0;
}

function renderOne(row) {
  currentRows.set(row.id, row);
  let el = rowEls.get(row.id);
  if (!el) {
    el = makeRowEl(row);
    rowEls.set(row.id, el);
    rowsHost.append(el);
    emptyState.hidden = true;
  }
  updateRowEl(el, row);
}

// countdown refresh for "Retrying in Ns" rows
setInterval(() => {
  for (const [id, row] of currentRows) {
    if (row.status === 'pending' && row.nextAttemptAt && row.nextAttemptAt > Date.now() && !row.note) {
      const el = rowEls.get(id);
      if (el) el._parts.stage.textContent = rowStateText(row);
    }
  }
}, 1000);

// ---------- status bar ----------

let enginePaused = false;

function renderStatus(info) {
  if (!info) return;
  $('statusText').textContent = info.text;
  const c = info.counts || {};
  $('statusCounts').textContent = c.total
    ? `· ${c.done + c.skipped || 0}/${c.total} done` + (c.failed ? ` · ${c.failed} failed` : '')
    : '';
  $('statusDot').className = 'dot ' + (info.kind || '');
  $('retryFailedBtn').hidden = !(c.failed > 0);
  $('downloadBtn').hidden = !(c.loaded > 0);
  enginePaused = Boolean(info.paused);
  $('pauseBtn').textContent = enginePaused ? 'Resume' : 'Pause';
}

// ---------- link bar ----------

function showLinkMsg(text, isError) {
  const el = $('linkMsg');
  el.textContent = text;
  el.className = isError ? 'error' : '';
  el.hidden = !text;
}

// The whole paste goes to the main process in one call — a single link, a
// pile of links, or the block of track links Spotify produces when you
// select every track in a playlist and copy.
async function addLink() {
  const input = $('linkInput');
  const raw = input.value.trim();
  if (!raw) return;
  const btn = $('addBtn');
  btn.disabled = true;
  btn.textContent = 'Reading…';
  showLinkMsg('');
  try {
    const r = await api.expandLink(raw);
    if (!r.ok) { showLinkMsg(r.error || 'Could not read that', true); return; }
    if (r.added > 0) input.value = '';

    const from = r.titles && r.titles.length === 1 ? ` from “${r.titles[0]}”` : '';
    let msg = `Loaded ${r.added} track${r.added === 1 ? '' : 's'}${from}`;
    if (r.alreadyHave) msg += ` — ${r.alreadyHave} already in your library, ${r.toDownload} to download`;
    msg += r.toDownload ? ' — press Download to start' : ' — nothing new to fetch';
    if (r.unavailable) msg += ` — ${r.unavailable} unavailable (shown as failed)`;
    if (r.errors && r.errors.length) msg += ` — ${r.errors.length} link${r.errors.length === 1 ? '' : 's'} failed: ${r.errors[0]}`;
    if (r.warning) msg += `. ${r.warning}`;

    const isBad = r.added === 0 || (r.errors && r.errors.length > 0) || Boolean(r.warning);
    showLinkMsg(msg, isBad);
    if (!isBad) setTimeout(() => { if ($('linkMsg').textContent === msg) showLinkMsg(''); }, 9000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
}

// ---------- watched playlists ----------
//
// Captured once from a pasted track list, then checked and downloaded only
// when asked. Each playlist keeps its own destination folder.

const TRACK_LINK_RE = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/|spotify:track:)[A-Za-z0-9]{22}/g;
const countLinks = (v) => (String(v || '').match(TRACK_LINK_RE) || []).length;

function whenText(ts) {
  if (!ts) return 'never checked';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'checked just now';
  if (mins < 60) return 'checked ' + mins + ' min ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return 'checked ' + hrs + ' h ago';
  return 'checked ' + Math.round(hrs / 24) + ' d ago';
}

function playlistCard(p) {
  const card = document.createElement('div');
  card.className = 'pl-card';

  const h = document.createElement('h3');
  h.textContent = p.name;
  const folder = document.createElement('div');
  folder.className = 'pl-folder';
  folder.textContent = p.folder;
  folder.title = p.folder;

  const counts = document.createElement('div');
  counts.className = 'pl-counts';
  const paint = () => {
    counts.innerHTML = '';
    const total = document.createElement('b');
    total.textContent = p.total;
    counts.append(total, document.createTextNode(' tracks \u00B7 '));
    if (p.lastResult) {
      counts.append(document.createTextNode(p.lastResult.have + ' in the folder \u00B7 '));
      const miss = document.createElement('span');
      if (p.lastResult.missing > 0) miss.className = 'new';
      miss.textContent = p.lastResult.missing + ' missing';
      counts.append(miss, document.createTextNode(' \u00B7 ' + whenText(p.lastCheckedAt)));
    } else {
      counts.append(document.createTextNode(whenText(p.lastCheckedAt)));
    }
  };
  paint();

  const actions = document.createElement('div');
  actions.className = 'pl-actions';

  const btnCheck = document.createElement('button');
  btnCheck.className = 'btn';
  btnCheck.textContent = 'Check for new';
  btnCheck.addEventListener('click', async () => {
    btnCheck.disabled = true;
    btnCheck.textContent = 'Checking\u2026';
    const r = await api.checkPlaylist(p.id);
    btnCheck.disabled = false;
    btnCheck.textContent = 'Check for new';
    if (!r.ok) { showLinkMsg(r.error, true); return; }
    Object.assign(p, r.playlist);
    paint();
    showLinkMsg(p.name + ': ' + r.playlist.lastResult.missing + ' missing of ' + r.playlist.lastResult.total, false);
  });

  const btnGet = document.createElement('button');
  btnGet.className = 'btn btn-primary';
  btnGet.textContent = 'Download new';
  btnGet.addEventListener('click', async () => {
    btnGet.disabled = true;
    btnGet.textContent = 'Queueing\u2026';
    const r = await api.downloadNew(p.id);
    btnGet.disabled = false;
    btnGet.textContent = 'Download new';
    if (!r.ok) { showLinkMsg(r.error, true); return; }
    if (r.playlist) { Object.assign(p, r.playlist); paint(); }
    showLinkMsg(r.added
      ? p.name + ': queued ' + r.added + ' track' + (r.added === 1 ? '' : 's') + ' \u2014 downloading now'
      : p.name + ': nothing new to download', false);
  });

  const btnUpdate = document.createElement('button');
  btnUpdate.className = 'btn';
  btnUpdate.textContent = p.sourceUrl ? 'Refresh from link' : 'Update list';

  const btnFolder = document.createElement('button');
  btnFolder.className = 'btn';
  btnFolder.textContent = 'Folder';
  btnFolder.addEventListener('click', async () => {
    const dir = await api.chooseFolder();
    if (!dir) return;
    await api.renamePlaylist({ id: p.id, folder: dir });
    p.folder = dir;
    folder.textContent = dir;
    folder.title = dir;
  });

  const btnCompare = document.createElement('button');
  btnCompare.className = 'btn';

  const btnRemove = document.createElement('button');
  btnRemove.className = 'btn btn-quiet';
  btnRemove.textContent = 'Remove';
  btnRemove.addEventListener('click', async () => {
    if (btnRemove.dataset.sure !== '1') {
      btnRemove.dataset.sure = '1';
      btnRemove.textContent = 'Remove \u2014 click again';
      setTimeout(() => { btnRemove.dataset.sure = '0'; btnRemove.textContent = 'Remove'; }, 4000);
      return;
    }
    await api.removePlaylist(p.id);
    renderPlaylists();
  });

  actions.append(btnCheck, btnGet, btnUpdate, btnFolder, btnCompare, btnRemove);

  // folders this playlist is compared against, saved with it
  const cmp = document.createElement('div');
  cmp.className = 'pl-update';
  const cmpList = document.createElement('div');
  cmpList.className = 'folder-list';
  const cmpHint = document.createElement('div');
  cmpHint.className = 'hint';
  cmpHint.textContent = 'A track found in any of these counts as already owned, '
    + 'on top of this playlist\u2019s own folder and anything in Settings \u203A Library.';

  const paintCmp = () => {
    const dirs = p.compareDirs || [];
    btnCompare.textContent = dirs.length ? 'Compare (' + dirs.length + ')' : 'Compare folders';
    cmpList.innerHTML = '';
    if (!dirs.length) {
      const none = document.createElement('div');
      none.className = 'folder-none';
      none.textContent = 'Only this playlist\u2019s own folder is checked.';
      cmpList.append(none);
    }
    dirs.forEach((dir, i) => {
      const row = document.createElement('div');
      row.className = 'folder-row';
      const txt = document.createElement('span');
      txt.textContent = dir;
      txt.title = dir;
      const del = document.createElement('button');
      del.className = 'row-btn';
      del.textContent = '\u2715';
      del.title = 'Stop comparing against this folder';
      del.addEventListener('click', async () => {
        const next = (p.compareDirs || []).slice();
        next.splice(i, 1);
        const r = await api.setPlaylistCompare({ id: p.id, dirs: next });
        if (r) Object.assign(p, r);
        paintCmp();
      });
      row.append(txt, del);
      cmpList.append(row);
    });
  };

  const cmpAdd = document.createElement('button');
  cmpAdd.className = 'btn';
  cmpAdd.textContent = 'Add a folder';
  cmpAdd.addEventListener('click', async () => {
    const dir = await api.chooseFolder();
    if (!dir) return;
    const next = (p.compareDirs || []).slice();
    if (next.includes(dir)) return;
    next.push(dir);
    const r = await api.setPlaylistCompare({ id: p.id, dirs: next });
    if (r) Object.assign(p, r);
    paintCmp();
  });
  const cmpRow = document.createElement('div');
  cmpRow.className = 'pl-actions';
  cmpRow.append(cmpAdd);
  cmp.append(cmpList, cmpRow, cmpHint);
  paintCmp();
  btnCompare.addEventListener('click', () => cmp.classList.toggle('open'));

  // re-paste after the playlist changed on Spotify
  const upd = document.createElement('div');
  upd.className = 'pl-update';
  const ta = document.createElement('textarea');
  ta.rows = 3;
  ta.spellcheck = false;
  ta.placeholder = 'Paste the copied track links again to refresh this list';
  const updRow = document.createElement('div');
  updRow.className = 'pl-actions';
  const updGo = document.createElement('button');
  updGo.className = 'btn';
  updGo.textContent = 'Save list';
  updGo.addEventListener('click', async () => {
    if (!countLinks(ta.value)) { showLinkMsg('No track links found in that paste', true); return; }
    updGo.disabled = true;
    updGo.textContent = 'Reading\u2026';
    const r = await api.updatePlaylist({ id: p.id, text: ta.value });
    updGo.disabled = false;
    updGo.textContent = 'Save list';
    if (!r.ok) { showLinkMsg(r.error, true); return; }
    Object.assign(p, r.playlist);
    paint();
    ta.value = '';
    upd.classList.remove('open');
    showLinkMsg(p.name + ': list now holds ' + r.playlist.total + ' tracks', false);
  });
  updRow.append(updGo);
  upd.append(ta, updRow);
  btnUpdate.addEventListener('click', async () => {
    // captured from a link? just re-read it. otherwise ask for a fresh paste.
    if (!p.sourceUrl) { upd.classList.toggle('open'); return; }
    btnUpdate.disabled = true;
    btnUpdate.textContent = 'Refreshing\u2026';
    const before = p.total;
    const r = await api.updatePlaylist({ id: p.id, text: '' });
    btnUpdate.disabled = false;
    btnUpdate.textContent = 'Refresh from link';
    if (!r.ok) { showLinkMsg(r.error, true); return; }
    Object.assign(p, r.playlist);
    paint();
    const gained = p.total - before;
    showLinkMsg(p.name + ': ' + (gained > 0 ? gained + ' new track' + (gained === 1 ? '' : 's') + ' added' : 'no change')
      + ' \u2014 ' + p.total + ' in the list'
      + (r.capped ? '. Only the first 100 could be read from the link; paste the copied track links to go further.' : ''),
      Boolean(r.capped));
  });

  card.append(h, folder, counts, actions, cmp, upd);
  return card;
}

async function renderPlaylists() {
  const host = $('plList');
  host.innerHTML = '';
  const lists = await api.listPlaylists();
  if (!lists.length) {
    const e = document.createElement('div');
    e.className = 'pl-empty';
    e.textContent = 'No watched playlists yet. Capture one above and it stays here \u2014 check it whenever you like.';
    host.append(e);
    return;
  }
  for (const p of lists) host.append(playlistCard(p));
}

function openPlaylists() {
  $('plPanel').hidden = false;
  $('plBackdrop').hidden = false;
  if (!$('plFolder').value) $('plFolder').value = settingsCache.outputDir || '';
  renderPlaylists();
}

function closePlaylists() {
  $('plPanel').hidden = true;
  $('plBackdrop').hidden = true;
}

function wirePlaylists() {
  $('playlistsBtn').addEventListener('click', openPlaylists);
  $('plClose').addEventListener('click', closePlaylists);
  $('plBackdrop').addEventListener('click', closePlaylists);

  $('plPaste').addEventListener('input', () => {
    const v = $('plPaste').value;
    const n = countLinks(v);
    const isList = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(playlist|album)\//.test(v);
    $('plPasteCount').textContent = n
      ? n + ' track links detected \u2014 no size limit'
      : (isList ? 'Playlist link detected' : '');
  });

  $('plBrowse').addEventListener('click', async () => {
    const dir = await api.chooseFolder();
    if (dir) $('plFolder').value = dir;
  });

  $('plAdd').addEventListener('click', async () => {
    const name = $('plName').value.trim();
    const folder = $('plFolder').value.trim();
    const text = $('plPaste').value;
    if (!text.trim()) { showLinkMsg('Paste a Spotify playlist link, or the copied track links', true); return; }
    if (!folder) { showLinkMsg('Choose a folder for this playlist', true); return; }
    const btn = $('plAdd');
    btn.disabled = true;
    btn.textContent = 'Reading\u2026';
    const r = await api.addPlaylist({ name: name || 'Playlist', folder, text });
    btn.disabled = false;
    btn.textContent = 'Capture playlist';
    if (!r.ok) { showLinkMsg(r.error, true); return; }
    $('plName').value = '';
    $('plPaste').value = '';
    $('plPasteCount').textContent = '';
    showLinkMsg('Captured \u201C' + r.playlist.name + '\u201D \u2014 ' + r.playlist.total + ' tracks.'
      + (r.localFiles ? ' ' + r.localFiles + ' local file' + (r.localFiles === 1 ? '' : 's')
          + ' in the playlist were left out \u2014 they are not on Spotify, so there is nothing to fetch.' : '')
      + (r.capped
        ? ' Only the first 100 could be read from the link \u2014 Spotify caps that for this app. For the rest, open the playlist, Ctrl+A, Ctrl+C and paste those links into Update list.'
        : ' Press Check for new whenever you like.'),
      Boolean(r.capped));
    renderPlaylists();
  });
}

// ---------- settings panel ----------

let settingsCache = {};

const FIELDS = {
  library: [
    { k: 'outputDir', label: 'Library folder', type: 'folder' },
    { k: 'folderTemplate', label: 'Folder structure', type: 'text', hint: 'Blank = no subfolders, everything straight into the library folder. Tokens: {artist} {albumArtist} {album} {year}' },
    { k: 'fileTemplate', label: 'File name', type: 'text', hint: 'Tokens: {artist} {title} {track} {disc} {year}' },
    { k: 'extraLibraryDirs', label: 'Also check these folders', type: 'folders', hint: 'Anything found in these counts as already owned and will not be downloaded again. Useful when your music is split across several folders.' },
    { k: 'skipExisting', label: 'Skip tracks already in the library', type: 'check', hint: 'Every link is checked against your library folder first, by tags rather than file name — tracks saved by another app under a different naming scheme are still recognised. Remixes and edits count as separate tracks.' },
  ],
  audio: [
    { k: 'bitrate', label: 'MP3 bitrate', type: 'select', options: [['320', '320 kbps'], ['256', '256 kbps'], ['192', '192 kbps'], ['V0', 'V0 (variable, ~245 kbps)']] },
    { k: 'normalise', label: 'Write ReplayGain loudness tags', type: 'check', hint: 'Tags only — the audio itself is never altered.' },
  ],
  metadata: [
    { k: 'spotifyClientId', label: 'Spotify client ID', type: 'text', hint: 'From the Spotify developer dashboard — create an app, tick Web API.' },
    { k: 'spotifyClientSecret', label: 'Spotify client secret', type: 'password' },
    { k: '_spotifyauth', type: 'spotifyauth' },
    { k: 'matchThreshold', label: 'Match confidence threshold', type: 'range', min: 0.5, max: 0.95, step: 0.01 },
    { k: 'noMatchBehaviour', label: 'When nothing matches', type: 'select', options: [['source', 'Tag from the video title'], ['blank', 'Save with empty tags'], ['skip', 'Mark failed for manual attention']] },
    { k: 'tagGenre', label: 'Write genre tags', type: 'check', hint: 'MusicBrainz first for a specific genre (garage house, deep house, acid house…), the artist’s Spotify genres as fallback. Nothing is written when neither source knows — no guessing.' },
    { k: 'embedArt', label: 'Embed cover art', type: 'check' },
    { k: 'artSize', label: 'Cover art size', type: 'select', options: [['640', '640 px'], ['300', '300 px'], ['64', '64 px']] },
    { k: 'writeM3u', label: 'Write .m3u8 playlist files for batches', type: 'check' },
  ],
  reliability: [
    { k: 'concurrency', label: 'Simultaneous downloads', type: 'range', min: 1, max: 8, step: 1, hint: 'Default 2. Higher usually makes a large playlist slower overall — throttling kicks in and everything backs off.' },
    { k: 'retries', label: 'Retries per track', type: 'range', min: 0, max: 8, step: 1 },
    { k: 'retryBackoffMs', label: 'Retry backoff base (ms)', type: 'number', hint: 'Delays grow exponentially from here, with jitter.' },
    { k: 'trackTimeoutSec', label: 'Per-track timeout (seconds)', type: 'number', hint: 'A hung track is killed and retried without touching the rest of the batch.' },
    { k: 'limitRate', label: 'Bandwidth cap', type: 'select', options: [['off', 'Off'], ['1M', '1 MB/s'], ['2M', '2 MB/s'], ['5M', '5 MB/s']], hint: 'Not saturating the connection is polite and less conspicuous.' },
    { k: 'resumeOnLaunch', label: 'Resume unfinished downloads on launch', type: 'check' },
  ],
  tools: [
    { k: '_toolstatus', type: 'toolstatus' },
    { k: 'autoUpdateYtdlp', label: 'Keep yt-dlp up to date automatically', type: 'check', hint: 'Checked at launch. A stale yt-dlp fails every download with a 403 — this is the single biggest cause of things breaking.' },
    { k: 'ytdlpPath', label: 'yt-dlp path (blank = bundled)', type: 'text' },
    { k: 'ffmpegPath', label: 'ffmpeg path (blank = bundled)', type: 'text' },
  ],
};

function fieldEl(def) {
  const wrap = document.createElement('div');
  wrap.className = 'field';

  if (def.type === 'folders') {
    const label = document.createElement('label');
    label.textContent = def.label;
    const list = document.createElement('div');
    list.className = 'folder-list';

    const paint = () => {
      const dirs = settingsCache[def.k] || [];
      list.innerHTML = '';
      if (!dirs.length) {
        const none = document.createElement('div');
        none.className = 'folder-none';
        none.textContent = 'None \u2014 only your library folder is checked.';
        list.append(none);
      }
      dirs.forEach((dir, i) => {
        const row = document.createElement('div');
        row.className = 'folder-row';
        const txt = document.createElement('span');
        txt.textContent = dir;
        txt.title = dir;
        const del = document.createElement('button');
        del.className = 'row-btn';
        del.textContent = '\u2715';
        del.title = 'Stop checking this folder';
        del.addEventListener('click', async () => {
          const next = (settingsCache[def.k] || []).slice();
          next.splice(i, 1);
          await save(def.k, next);
          paint();
        });
        row.append(txt, del);
        list.append(row);
      });
    };
    paint();

    const addBtn = document.createElement('button');
    addBtn.className = 'btn';
    addBtn.textContent = 'Add a folder';
    addBtn.addEventListener('click', async () => {
      const dir = await api.chooseFolder();
      if (!dir) return;
      const next = (settingsCache[def.k] || []).slice();
      if (next.includes(dir)) return;
      next.push(dir);
      await save(def.k, next);
      paint();
    });

    wrap.append(label, list, addBtn);
    if (def.hint) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = def.hint;
      wrap.append(hint);
    }
    return wrap;
  }

  if (def.type === 'spotifyauth') {
    const label = document.createElement('label');
    label.textContent = 'Spotify account (optional)';
    const status = document.createElement('div');
    status.className = 'tool-status';
    status.textContent = 'Checking…';
    const row = document.createElement('div');
    row.className = 'field-row';
    const btn = document.createElement('button');
    btn.className = 'btn';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Tested and confirmed: signing in does NOT unlock playlist listing — Spotify refuses that to developer apps created under its current policy, with any token, even for playlists you own. Connecting buys nothing today; it is kept in case that policy changes. Read-only access, revocable at spotify.com/account/apps.';

    const refresh = async () => {
      const st = await api.spotifyStatus();
      status.textContent = st.connected ? '● Connected (read-only)' : '● Not connected';
      status.style.color = st.connected ? 'var(--green)' : 'var(--text-dim)';
      btn.textContent = st.connected ? 'Disconnect' : 'Connect Spotify account';
    };
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const st = await api.spotifyStatus();
      if (st.connected) {
        await api.spotifyDisconnect();
      } else {
        btn.textContent = 'Waiting for your browser…';
        const r = await api.spotifyConnect();
        if (!r.ok) { status.textContent = r.error; status.style.color = 'var(--red)'; }
      }
      btn.disabled = false;
      refresh();
    });
    refresh();
    row.append(btn);
    wrap.append(label, status, row, hint);
    return wrap;
  }

  if (def.type === 'toolstatus') {
    wrap.innerHTML = '';
    const status = document.createElement('div');
    status.className = 'tool-status';
    status.id = 'toolStatus';
    status.textContent = 'Checking tools…';
    const row = document.createElement('div');
    row.className = 'field-row';
    const dlBtn = document.createElement('button');
    dlBtn.className = 'btn';
    dlBtn.textContent = 'Download yt-dlp';
    dlBtn.addEventListener('click', async () => {
      dlBtn.disabled = true;
      dlBtn.textContent = 'Downloading…';
      const r = await api.downloadYtdlp();
      dlBtn.disabled = false;
      dlBtn.textContent = 'Download yt-dlp';
      if (!r.ok) status.textContent = `Download failed: ${r.error}`;
      refreshTools();
    });
    const upBtn = document.createElement('button');
    upBtn.className = 'btn';
    upBtn.textContent = 'Update yt-dlp';
    upBtn.addEventListener('click', async () => {
      upBtn.disabled = true;
      upBtn.textContent = 'Updating…';
      const r = await api.updateYtdlp();
      upBtn.disabled = false;
      upBtn.textContent = 'Update yt-dlp';
      if (!r.ok) status.textContent = `Update failed: ${r.error}`;
      refreshTools();
    });
    row.append(dlBtn, upBtn);
    wrap.append(status, row);
    return wrap;
  }

  const label = document.createElement('label');
  label.textContent = def.label;

  let input;
  if (def.type === 'check') {
    wrap.className = 'field field-check';
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(settingsCache[def.k]);
    input.addEventListener('change', () => save(def.k, input.checked));
    wrap.append(input, label);
  } else if (def.type === 'select') {
    input = document.createElement('select');
    for (const [v, text] of def.options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = text;
      input.append(o);
    }
    input.value = String(settingsCache[def.k]);
    input.addEventListener('change', () => save(def.k, input.value));
    wrap.append(label, input);
  } else if (def.type === 'range') {
    const val = document.createElement('span');
    val.className = 'range-val';
    val.textContent = String(settingsCache[def.k]);
    label.append(document.createTextNode('  '), val);
    input = document.createElement('input');
    input.type = 'range';
    input.min = def.min; input.max = def.max; input.step = def.step;
    input.value = Number(settingsCache[def.k]);
    input.addEventListener('input', () => { val.textContent = input.value; });
    input.addEventListener('change', () => save(def.k, Number(input.value)));
    wrap.append(label, input);
  } else if (def.type === 'folder') {
    input = document.createElement('input');
    input.type = 'text';
    input.value = settingsCache[def.k] || '';
    input.addEventListener('input', debounce(() => save(def.k, input.value.trim()), 400));
    const row = document.createElement('div');
    row.className = 'field-row';
    const browse = document.createElement('button');
    browse.className = 'btn';
    browse.textContent = 'Browse';
    browse.addEventListener('click', async () => {
      const p = await api.chooseFolder();
      if (p) { input.value = p; save(def.k, p); }
    });
    row.append(input, browse);
    wrap.append(label, row);
  } else if (def.type === 'number') {
    input = document.createElement('input');
    input.type = 'number';
    input.value = Number(settingsCache[def.k]);
    input.addEventListener('input', debounce(() => {
      const n = Number(input.value);
      if (Number.isFinite(n)) save(def.k, n);
    }, 400));
    wrap.append(label, input);
  } else {
    input = document.createElement('input');
    input.type = def.type === 'password' ? 'password' : 'text';
    input.value = settingsCache[def.k] || '';
    input.spellcheck = false;
    input.addEventListener('input', debounce(() => save(def.k, input.value.trim()), 400));
    wrap.append(label, input);
  }

  if (def.hint) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = def.hint;
    wrap.append(hint);
  }
  return wrap;
}

let saveFlashTimer = null;

async function save(key, value) {
  settingsCache = await api.setSettings({ [key]: value });
  const el = $('saveState');
  if (el) {
    el.textContent = 'Saved';
    clearTimeout(saveFlashTimer);
    saveFlashTimer = setTimeout(() => { el.textContent = ''; }, 1500);
  }
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function renderTab(tab) {
  const body = $('spBody');
  body.innerHTML = '';
  for (const def of FIELDS[tab]) body.append(fieldEl(def));
  if (tab === 'tools') refreshTools();
}

async function refreshTools() {
  const el = $('toolStatus');
  if (!el) return;
  el.textContent = 'Checking tools…';
  const t = await api.checkTools();
  el.innerHTML = '';
  const line = (label, ok, detail) => {
    const div = document.createElement('div');
    const mark = document.createElement('span');
    mark.className = ok ? 'ok' : 'bad';
    mark.textContent = ok ? '● ' : '● ';
    div.append(mark, document.createTextNode(`${label}: ${detail}`));
    el.append(div);
  };
  if (t.ytdlp) {
    line('yt-dlp', true, `${t.ytdlp.version} (${t.ytdlp.path})`);
    if (t.updateAvailable) line('update', false, `${t.updateAvailable} available — extractors break when sites change`);
  } else {
    line('yt-dlp', false, 'not found — download it below');
  }
  line('ffmpeg', Boolean(t.ffmpeg), t.ffmpeg || 'not found');
}

function openSettings() {
  $('settingsPanel').hidden = false;
  $('settingsBackdrop').hidden = false;
}
function closeSettings() {
  $('settingsPanel').hidden = true;
  $('settingsBackdrop').hidden = true;
}

// ---------- wiring ----------

async function boot() {
  if (!api) {
    $('statusText').textContent = 'Preview mode — run via npm start for the real app';
    return;
  }

  settingsCache = await api.getSettings();
  renderTab('library');

  const q = await api.getQueue();
  renderAll(q.rows);
  renderStatus(q.status);

  api.onRows((rows) => renderAll(rows));
  api.onRow((row) => renderOne(row));
  api.onStatus((info) => renderStatus(info));
  api.onNotice((n) => {
    showLinkMsg(n.text, n.kind === 'error');
    if (n.kind !== 'error') setTimeout(() => { if ($('linkMsg').textContent === n.text) showLinkMsg(''); }, 6000);
  });

  $('addBtn').addEventListener('click', addLink);
  $('linkInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addLink(); });

  // A pasted playlist is thousands of links in a one-line box, which looks
  // like nothing happened. Say what was caught.
  $('linkInput').addEventListener('input', () => {
    const v = $('linkInput').value;
    const n = (v.match(/(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/|spotify:track:)[A-Za-z0-9]{22}/g) || []).length;
    if (n > 1) showLinkMsg(`${n} track links ready — press Add`, false);
    else if (!v.trim()) showLinkMsg('');
  });
  $('downloadBtn').addEventListener('click', () => api.startDownloads());

  $('pauseBtn').addEventListener('click', async () => {
    enginePaused = await api.setPaused(!enginePaused);
    $('pauseBtn').textContent = enginePaused ? 'Resume' : 'Pause';
  });

  $('retryFailedBtn').addEventListener('click', () => api.retryFailed());
  $('clearBtn').addEventListener('click', () => api.clearFinished());

  wirePlaylists();

  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', closeSettings);
  $('settingsBackdrop').addEventListener('click', closeSettings);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSettings(); closePlaylists(); } });

  $('spTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    for (const b of $('spTabs').querySelectorAll('button')) b.classList.toggle('active', b === btn);
    renderTab(btn.dataset.tab);
  });

  $('winMin').addEventListener('click', () => api.winControl('min'));
  $('winMax').addEventListener('click', () => api.winControl('max'));
  $('winClose').addEventListener('click', () => api.winControl('close'));
}

boot();
