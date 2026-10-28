// The download engine. One pipeline run per track, isolated: resolve →
// match → skip-check → download → convert → art → tag → place. Errors are
// classified (BRIEF.md §5.2); rate limits trip the per-host circuit breaker
// and rows go back to pending — never failed by throttling.
'use strict';

const fs = require('fs');
const path = require('path');
const NodeID3 = require('node-id3');
const { CrateError, fullJitter, prettyHost } = require('./politeness');
const matcher = require('./matcher');

let ctx = null; // { manifest, settings, spotify, tools, limiter, breaker, userData, emitStatus }
let timer = null;
let paused = false;
let tmpDir = null;
let artDir = null;
const inflight = new Set();
const progressStamp = new Map();
let wasDraining = false;
let lastStatusJson = '';

function init(c) {
  ctx = c;
  tmpDir = path.join(ctx.userData, 'tmp');
  artDir = path.join(ctx.userData, 'cache', 'art');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(artDir, { recursive: true });
  for (const f of fs.readdirSync(tmpDir)) {
    try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* stale temp */ }
  }
  ctx.breaker.onChange(() => emitStatus(true));
  timer = setInterval(tick, 750);
  tick();
}

function stop() { clearInterval(timer); }

function setPaused(v) {
  paused = Boolean(v);
  emitStatus(true);
  if (!paused) tick();
}
function isPaused() { return paused; }
function notify() { tick(); }

function hostFor(row) {
  if (row.sourceKind === 'soundcloud') return 'soundcloud.com';
  return 'www.youtube.com';
}

// ---------- scheduling ----------

function tick() {
  if (!ctx) return;
  const s = ctx.settings.get();
  emitStatus();
  if (paused) return;
  const now = Date.now();
  let capacity = Math.max(1, Math.min(8, s.concurrency || 2)) - inflight.size;
  if (capacity <= 0) return;
  for (const row of ctx.manifest.rows()) {
    if (capacity <= 0) break;
    if (row.status !== 'pending' || inflight.has(row.id)) continue;
    if (row.nextAttemptAt && row.nextAttemptAt > now) continue;
    if (ctx.breaker.isBlocked(hostFor(row))) continue;
    capacity -= 1;
    runRow(row.id);
  }
}

function patch(id, p) { return ctx.manifest.update(id, p); }

function patchProgress(id, stage, frac) {
  const now = Date.now();
  const last = progressStamp.get(id) || 0;
  if (now - last < 250 && frac < 1) return;
  progressStamp.set(id, now);
  patch(id, { stage, progress: frac });
}

async function runRow(id) {
  inflight.add(id);
  let row = patch(id, { status: 'working', stage: 'start', progress: 0, error: null, note: null });
  const s = ctx.settings.get();
  try {
    row = await stResolve(row, s);
    row = await stMatch(row, s);
    // Indexes are cached, so this is a no-op after the first track.
    if (s.skipExisting && ctx.library) {
      try { await ctx.library.ensureAll(libraryDirsFor(row, s)); } catch { /* checked below anyway */ }
    }
    const skipped = stSkipCheck(row, s);
    if (!skipped) {
      // MusicBrainz is capped at 1 request/second, so the genre lookup runs
      // alongside the download instead of adding its latency after it.
      const genreWork = startGenre(row, s);
      row = await stDownload(row, s);
      row = await stConvert(row, s);
      row = await stArt(row, s);
      row = await awaitGenre(row, genreWork);
      row = await stTag(row, s);
      row = await stPlace(row, s);
      ctx.breaker.noteSuccess(hostFor(row));
    }
  } catch (err) {
    handleFailure(id, err, s);
  } finally {
    inflight.delete(id);
    progressStamp.delete(id);
    cleanupTemp(id);
    setTimeout(tick, 50);
  }
}

function handleFailure(id, err, s) {
  const row = ctx.manifest.getRow(id);
  if (!row) return;
  const kind = err && err.kind ? err.kind : 'transient';
  const msg = (err && err.message) || 'Unknown error';

  if (kind === 'ratelimit') {
    const host = err.host || hostFor(row);
    const until = err.until || ctx.breaker.noteRateLimit(host, err.retryAfterMs || 0).until;
    // Not the row's fault: no attempt consumed, no failure. Work resumes by itself.
    patch(id, { status: 'pending', stage: null, progress: 0, nextAttemptAt: until, error: null, note: `${prettyHost(host)} is rate limiting — waiting` });
    return;
  }
  if (kind === 'permanent' || kind === 'auth' || kind === 'extractor' || kind === 'tooling') {
    // Retrying cannot fix these; retrying only adds load.
    patch(id, { status: 'failed', stage: null, error: msg });
    return;
  }
  const attempts = (row.attempts || 0) + 1;
  if (attempts > (s.retries != null ? s.retries : 3)) {
    patch(id, { status: 'failed', stage: null, error: `${msg} (gave up after ${attempts} attempts)`, attempts });
  } else {
    const delay = fullJitter(attempts, s.retryBackoffMs || 2000, 300000);
    patch(id, {
      status: 'pending', stage: null, progress: 0, attempts,
      nextAttemptAt: Date.now() + delay, error: null,
      note: `${msg} — retry ${attempts} of ${s.retries} in ${Math.max(1, Math.round(delay / 1000))}s`,
    });
  }
}

function cleanupTemp(id) {
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      if (f.startsWith(id + '.')) { try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* in use */ } }
    }
  } catch { /* tmp dir gone */ }
}

// ---------- stages ----------

// Full marks within 5s, fading to zero at 75s apart. Wider than the release
// matcher's window: here we only need the right recording, and uploads
// routinely carry a few seconds of intro or a longer club edit.
function resolveDurationScore(aSec, bSec) {
  const diff = Math.abs(aSec - bSec);
  if (diff <= 5) return 1;
  if (diff >= 75) return 0;
  return 1 - (diff - 5) / 70;
}

// Spotify rows know the release but not where the audio lives. Search
// YouTube, score by title + duration, prefer auto-generated "Topic" uploads.
async function stResolve(row, s) {
  if (!row.needsResolve || row.sourceUrl) return row;
  patch(row.id, { stage: 'resolve', progress: 0 });
  const m = row.meta;
  const q = `${m.artist} ${m.title}`;
  await ctx.limiter.take('www.youtube.com');
  const j = await ctx.tools.runYtdlpJson(
    ['--flat-playlist', '-J', '--no-warnings', '--socket-timeout', '30', `ytsearch6:${q}`],
    { timeoutMs: 120000 }
  );
  const entries = (j.entries || []).filter(Boolean);
  const wantSec = m.durationMs ? m.durationMs / 1000 : null;
  let best = null;
  for (const e of entries) {
    const ch = String(e.channel || e.uploader || '');
    // The artist lives in the title on most uploads but in the channel name
    // on auto-generated "- Topic" ones, so both are searched.
    const hay = `${e.title || ''} ${ch}`;
    const t = Math.max(
      matcher.tokenSetRatio(e.title || '', m.title),
      matcher.tokenSetRatio(hay, q)
    );
    const a = m.artist ? matcher.tokenSetRatio(hay, m.artist) : 0.5;
    // Uploads carry intros, outros and DJ edits, so length agreement is
    // looser here than when identifying a release.
    const d = e.duration != null && wantSec != null ? resolveDurationScore(e.duration, wantSec) : 0.4;
    const bonus = /- topic$/i.test(ch) ? 0.12 : (matcher.tokenSetRatio(ch, m.artist) > 0.5 ? 0.06 : 0);
    // Version mismatch guard: don't grab the original when we owe a remix.
    const versionPenalty = matcher.versionKey(e.title || '') === matcher.versionKey(m.title) ? 1 : 0.3;
    const score = (0.45 * t + 0.25 * a + 0.3 * d) * versionPenalty + bonus;
    if (!best || score > best.score) best = { entry: e, score, lengthOff: d < 0.35 };
  }
  if (!best || best.score < 0.45) {
    throw new CrateError('permanent', "Couldn't find a matching audio source on YouTube for this track");
  }
  if (best.lengthOff) {
    patch(row.id, { note: 'Closest upload runs a different length — may be a different edit' });
  }
  const e = best.entry;
  return patch(row.id, {
    sourceUrl: e.url && /^https?:/i.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
    sourceUploader: e.channel || e.uploader || null,
    sourceDurationSec: e.duration != null ? Math.round(e.duration) : row.sourceDurationSec,
  });
}

// YouTube/SoundCloud rows: turn the messy source title into real release
// metadata via Spotify. Runs before download so skip-existing can check the
// real destination first — cached searches make re-runs near-free.
async function stMatch(row, s) {
  if (row.matched && row.meta && row.meta.spotifyId) return row;
  patch(row.id, { stage: 'match', progress: 0 });
  const parsed = matcher.parseSource(row.sourceTitle, row.sourceUploader);

  if (!ctx.spotify.hasCreds()) {
    return applyNoMatch(row, s, parsed, 'Spotify credentials not set');
  }
  let result;
  try {
    result = await matcher.match(
      { title: parsed.title, artist: parsed.artist, durationSec: row.sourceDurationSec },
      { spotify: ctx.spotify, threshold: s.matchThreshold || 0.72, artSize: s.artSize }
    );
  } catch (err) {
    if (err.kind === 'ratelimit') throw err;
    if (err.kind === 'auth') return applyNoMatch(row, s, parsed, err.message);
    throw err;
  }
  if (result.matched) {
    return patch(row.id, { meta: result.meta, matched: true, matchMode: 'matched', matchScore: +result.score.toFixed(3) });
  }
  return applyNoMatch(row, s, parsed, `No Spotify match above ${(s.matchThreshold || 0.72).toFixed(2)} (best ${result.score.toFixed(2)})`);
}

function applyNoMatch(row, s, parsed, reason) {
  const behaviour = s.noMatchBehaviour || 'source';
  if (behaviour === 'skip') {
    // Left in the queue for manual attention.
    throw new CrateError('permanent', `${reason} — skipped by your no-match setting`);
  }
  const meta = {
    title: parsed.title || row.sourceTitle || 'Untitled',
    artist: parsed.artist || '',
    albumArtist: parsed.artist || '',
    album: '', albumId: null, trackNo: null, trackTotal: null,
    discNo: null, year: null, isrc: null, spotifyId: null,
    durationMs: row.sourceDurationSec ? row.sourceDurationSec * 1000 : null,
    artUrl: behaviour === 'source' ? row.sourceThumb : null,
  };
  return patch(row.id, { meta, matched: false, matchMode: behaviour, note: reason });
}

// ---------- path building ----------

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function sanitizeSegment(seg) {
  let out = String(seg || '')
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/[ -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, ''); // Windows: no trailing dots or spaces
  if (RESERVED.test(out)) out = '_' + out;
  return out;
}

function renderTemplate(tpl, vars) {
  return String(tpl || '')
    .replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null && vars[k] !== '' ? String(vars[k]) : ''))
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—.]+|[\s\-–—.]+$/g, '')
    .trim();
}

function buildDest(row, s) {
  const m = row.meta || {};
  const vars = {
    // the performer of this track — on a compilation the album artist is
    // "Various Artists", which is not what belongs on the file
    artist: m.artist || m.albumArtist || 'Unknown Artist',
    albumArtist: m.albumArtist || m.artist || 'Unknown Artist',
    album: m.album || 'Unknown Album',
    title: m.title || row.sourceTitle || 'Untitled',
    track: m.trackNo != null ? String(m.trackNo).padStart(2, '0') : '',
    disc: m.discNo != null ? String(m.discNo) : '',
    year: m.year || '',
  };
  const baseDir = row.destDir || s.outputDir;
  const folders = String(s.folderTemplate == null ? '' : s.folderTemplate)
    .split('/')
    .map((seg) => sanitizeSegment(renderTemplate(seg, vars)))
    .filter(Boolean);
  let fileName = sanitizeSegment(renderTemplate(s.fileTemplate || '{title} - {artist}', vars)) || 'Untitled';

  let full = path.join(baseDir, ...folders, fileName + '.mp3');
  if (full.length > 250) {
    const over = full.length - 250;
    fileName = fileName.slice(0, Math.max(8, fileName.length - over));
    full = path.join(baseDir, ...folders, fileName + '.mp3');
  }
  return full;
}

// Where a track counts as "already owned": its own destination first, then
// any extra folders the user listed.
function libraryDirsFor(row, s) {
  return [row.destDir || s.outputDir, ...(s.extraLibraryDirs || [])];
}

// Honour skipExisting before doing any network work at all.
function stSkipCheck(row, s) {
  const dest = buildDest(row, s);
  patch(row.id, { destPath: dest });
  if (!s.skipExisting) return false;

  try {
    const st = fs.statSync(dest);
    if (st.size > 0) {
      patch(row.id, { status: 'skipped', stage: null, progress: 1, filePath: dest, note: 'Already in the library' });
      return true;
    }
  } catch { /* not at that exact path — the library index may still know it */ }

  // Rows that only learn their metadata during matching (anything from
  // YouTube) reach the library check here rather than at expansion time.
  if (ctx.library && row.meta && row.meta.title) {
    const hit = ctx.library.findAny(ctx.library.currentAll(libraryDirsFor(row, s)), row.meta);
    if (hit) {
      patch(row.id, {
        status: 'skipped', stage: null, progress: 1, filePath: hit.file,
        note: 'Already in your library (matched by ' + hit.how + ')',
      });
      return true;
    }
  }
  return false;
}

async function stDownload(row, s) {
  if (!row.sourceUrl) throw new CrateError('permanent', 'No source URL for this track');
  patch(row.id, { stage: 'download', progress: 0 });
  await ctx.limiter.take(hostFor(row));
  const outTmpl = path.join(tmpDir, `${row.id}.src.%(ext)s`);
  const args = [
    '--no-playlist',
    '-f', 'bestaudio/best',
    '-o', outTmpl,
    '--newline',
    '--progress-template', 'dl:%(progress)j',
    '--no-warnings',
    '--socket-timeout', '20',
    '--retries', '2',
    '--concurrent-fragments', '8',   // parallel fragments within one track
    '--no-mtime',
    // a small gap between metadata requests still spreads load, without the
    // fixed multi-second stall the queue used to pay per track
    '--sleep-requests', '0.3',
  ];
  if (s.limitRate && s.limitRate !== 'off') args.push('--limit-rate', s.limitRate);
  args.push(row.sourceUrl);

  await ctx.tools.runYtdlp(args, {
    timeoutMs: Math.max(30, s.trackTimeoutSec || 300) * 1000,
    onProgress: (frac) => patchProgress(row.id, 'download', frac),
  });

  const found = fs.readdirSync(tmpDir).find((f) => f.startsWith(`${row.id}.src.`) && !f.endsWith('.part'));
  if (!found) throw new CrateError('transient', 'Download finished but no file appeared — will retry');
  const tmpAudio = path.join(tmpDir, found);
  if (fs.statSync(tmpAudio).size === 0) throw new CrateError('transient', 'Downloaded file is empty — will retry');
  return patch(row.id, { tmpAudio, progress: 1 });
}

async function stConvert(row, s) {
  patch(row.id, { stage: 'convert', progress: 0.2 });
  const src = row.tmpAudio;
  const out = path.join(tmpDir, `${row.id}.mp3`);
  if (src.toLowerCase().endsWith('.mp3')) {
    fs.renameSync(src, out);
  } else {
    await ctx.tools.convertToMp3(src, out, { bitrate: s.bitrate });
    try { fs.unlinkSync(src); } catch { /* already gone */ }
  }
  let gainDb = null;
  if (s.normalise) {
    patch(row.id, { stage: 'convert', progress: 0.8, note: 'Measuring loudness' });
    gainDb = await ctx.tools.measureGain(out);
  }
  return patch(row.id, { tmpAudio: out, gainDb, progress: 1, note: null });
}

// Cover art cached by album — a 12-track album needs one image download.
async function stArt(row, s) {
  if (!s.embedArt) return row;
  const m = row.meta || {};
  if (!m.artUrl) return row;
  patch(row.id, { stage: 'art', progress: 0.5 });
  const key = m.albumId ? `${m.albumId}_${s.artSize}` : `row_${row.id}`;
  const artPath = path.join(artDir, key + '.jpg');
  if (!fs.existsSync(artPath) || fs.statSync(artPath).size === 0) {
    let host = 'i.scdn.co';
    try { host = new URL(m.artUrl).hostname; } catch { /* keep default */ }
    await ctx.limiter.take(host);
    let res;
    try {
      res = await fetch(m.artUrl, { signal: AbortSignal.timeout(30000) });
    } catch {
      return patch(row.id, { note: "Couldn't fetch cover art — continuing without it" });
    }
    if (res.status === 429) {
      const r = ctx.breaker.noteRateLimit(host, 0);
      throw new CrateError('ratelimit', 'Art host is rate limiting', { host, until: r.until });
    }
    if (!res.ok) return patch(row.id, { note: `Cover art unavailable (HTTP ${res.status}) — continuing without it` });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 0) {
      const kind = ctx.tools.sniffImage(buf);
      const tmp = artPath + '.tmp';
      if (kind === 'jpeg') {
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, artPath);
      } else {
        // YouTube thumbnails are usually WebP. Labelling those image/jpeg is
        // what makes players reject the cover art, so convert for real.
        const raw = artPath + '.raw';
        fs.writeFileSync(raw, buf);
        const ok = await ctx.tools.toJpeg(raw, tmp);
        try { fs.unlinkSync(raw); } catch { /* already gone */ }
        if (ok) fs.renameSync(tmp, artPath);
        else {
          try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
          return patch(row.id, { note: 'Cover art was in an unusable format — continuing without it' });
        }
      }
    }
  }
  return patch(row.id, { artPath, progress: 1 });
}

// Genre lookup: MusicBrainz (specific, curated), Spotify artist genres as
// fallback. Best-effort by design — a lookup failure never fails the track,
// and no genre is written rather than a guessed one. Kicked off before the
// download and collected after, so its rate-limited wait overlaps the audio.
function startGenre(row, s) {
  if (!s.tagGenre || !ctx.genre || row.matchMode === 'blank') return null;
  const m = row.meta || {};
  if (!m.title && !m.isrc) return null;
  return ctx.genre.forTrack({
    isrc: m.isrc || null,
    artist: m.artist || '',
    title: m.title || '',
    album: m.album || '',
    artistIds: m.artistIds || [],
  }).catch(() => null);
}

async function awaitGenre(row, work) {
  if (!work) return row;
  patch(row.id, { stage: 'genre', progress: 0.9 });
  const g = await work;
  if (g && g.genre) return patch(row.id, { genre: g.genre, genreSource: g.source, progress: 1 });
  return patch(row.id, { progress: 1 });
}

async function stTag(row, s) {
  patch(row.id, { stage: 'tag', progress: 0.5 });
  const m = row.meta || {};

  if (row.matchMode === 'blank') {
    return patch(row.id, { tagged: false, progress: 1 });
  }

  const tags = {
    title: m.title || undefined,
    artist: m.artist || undefined,
    performerInfo: m.albumArtist || undefined,      // TPE2
    album: m.album || undefined,
    year: m.year || undefined,
    trackNumber: m.trackNo != null ? (m.trackTotal ? `${m.trackNo}/${m.trackTotal}` : String(m.trackNo)) : undefined,
    partOfSet: m.discNo != null ? String(m.discNo) : undefined,   // TPOS
    isrc: m.isrc || undefined,                       // TSRC — the definitive recording id
    genre: row.genre || undefined,                   // TCON — from the genre tagger
  };

  const txxx = [];
  if (m.spotifyId) txxx.push({ description: 'SPOTIFY_TRACK_ID', value: m.spotifyId }); // makes future re-tagging exact
  if (row.gainDb != null) txxx.push({ description: 'REPLAYGAIN_TRACK_GAIN', value: `${row.gainDb.toFixed(2)} dB` });
  if (txxx.length) tags.userDefinedText = txxx;

  if (s.embedArt && row.artPath && fs.existsSync(row.artPath)) {
    const imageBuffer = fs.readFileSync(row.artPath);
    const kind = ctx.tools.sniffImage(imageBuffer);
    // Only embed what we can honestly declare — a mislabelled frame is worse
    // than no artwork, because players refuse the whole tag.
    if (kind === 'jpeg' || kind === 'png') {
      tags.image = {
        mime: kind === 'png' ? 'image/png' : 'image/jpeg',
        type: { id: 3, name: 'front cover' },
        description: '',
        imageBuffer,
      };
    }
  }

  const ok = NodeID3.write(tags, row.tmpAudio);
  if (ok !== true) throw new CrateError('transient', 'Writing tags failed — will retry');

  // tagged only means "confirmed Spotify match written" — the UI shows
  // source-tagged rows desaturated rather than pretending.
  return patch(row.id, { tagged: row.matchMode === 'matched', progress: 1 });
}

async function stPlace(row, s) {
  patch(row.id, { stage: 'place', progress: 0.5 });
  const dest = row.destPath || buildDest(row, s);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(row.tmpAudio, dest);
  } catch {
    fs.copyFileSync(row.tmpAudio, dest);
    fs.unlinkSync(row.tmpAudio);
  }
  // Only done after the finished file has been stat'd and found non-zero.
  const st = fs.statSync(dest);
  if (!st.size) throw new CrateError('transient', 'Placed file is empty — will retry');
  return patch(row.id, { status: 'done', stage: null, progress: 1, filePath: dest, tmpAudio: null, note: null });
}

// ---------- status + reconciliation ----------

function statusInfo() {
  const c = ctx.manifest.counts();
  const br = ctx.breaker.active();
  let text = '';
  let kind = 'idle';
  if (br) {
    const mins = Math.max(1, Math.ceil((br.until - Date.now()) / 60000));
    text = `${prettyHost(br.host)} is rate limiting. Paused for ${mins} minute${mins === 1 ? '' : 's'}, then continuing automatically.`;
    kind = 'warn';
  } else if (paused && c.pending + c.working > 0) {
    text = `Paused — ${c.pending + c.working} track${c.pending + c.working === 1 ? '' : 's'} waiting`;
    kind = 'idle';
  } else if (c.working > 0 || c.pending > 0) {
    text = `${c.working} in flight · ${c.pending} queued`;
    kind = 'working';
  } else if (c.loaded > 0) {
    text = `${c.loaded} track${c.loaded === 1 ? '' : 's'} loaded — press Download to start`;
    kind = 'idle';
  } else if (c.total > 0) {
    const got = c.done + c.skipped;
    text = c.failed > 0 ? `${got} of ${c.total} downloaded, ${c.failed} failed` : `${got} of ${c.total} downloaded`;
    kind = c.failed > 0 ? 'warn' : 'done';
  } else {
    text = 'Paste a link to begin';
  }
  return { text, kind, counts: c, paused, breaker: br };
}

function emitStatus(force = false) {
  if (!ctx) return;
  const info = statusInfo();
  const j = JSON.stringify(info);
  if (!force && j === lastStatusJson) return;
  lastStatusJson = j;
  ctx.emitStatus(info);
  maybeDrain(info.counts);
}

function maybeDrain(c) {
  const draining = c.total > 0 && c.pending === 0 && c.working === 0 && c.loaded === 0;
  if (draining && !wasDraining) {
    wasDraining = true;
    onBatchDrained();
  } else if (!draining) {
    wasDraining = false;
  }
}

function onBatchDrained() {
  const s = ctx.settings.get();
  if (!s.writeM3u) return;
  try {
    const rows = ctx.manifest.rows();
    for (const b of ctx.manifest.batches()) {
      const bRows = rows.filter((r) => r.batchId === b.id);
      if (bRows.length < 2) continue;
      const done = bRows.filter((r) => (r.status === 'done' || r.status === 'skipped') && r.filePath);
      if (!done.length) continue;
      const name = sanitizeSegment(b.title || 'Playlist') || 'Playlist';
      const lines = ['#EXTM3U'];
      for (const r of done) {
        const m = r.meta || {};
        const sec = m.durationMs ? Math.round(m.durationMs / 1000) : -1;
        lines.push(`#EXTINF:${sec},${m.artist || ''} - ${m.title || r.sourceTitle || ''}`);
        lines.push(r.filePath);
      }
      fs.mkdirSync(s.outputDir, { recursive: true });
      fs.writeFileSync(path.join(s.outputDir, name + '.m3u8'), lines.join('\n') + '\n', 'utf8');
    }
  } catch { /* playlist files are a convenience, never fatal */ }
}

module.exports = { init, stop, setPaused, isPaused, notify, statusInfo, buildDest };
