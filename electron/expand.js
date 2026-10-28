// Link expansion — BRIEF.md §4. Expand first, download second: the complete
// track list is written to the manifest before a single byte of audio is
// fetched, with explicit truncation checks. Unavailable entries become
// failed rows with a reason, never omissions.
'use strict';

const manifest = require('./manifest');
const { CrateError } = require('./politeness');
const { metaFromTrack } = require('./matcher');

function classify(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return { kind: 'invalid' };
  }
  const host = u.hostname.replace(/^www\.|^m\./, '').toLowerCase();

  const sp = u.pathname.match(/^\/(?:intl-[a-z-]+\/)?(track|album|playlist)\/([A-Za-z0-9]{10,})/);
  if (host === 'open.spotify.com' && sp) return { kind: `spotify-${sp[1]}`, id: sp[2] };
  if (host.endsWith('spotify.com')) return { kind: 'unsupported-spotify' };

  if (host === 'youtu.be') return { kind: 'yt-video', url: rawUrl };
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    if (u.pathname === '/playlist' && u.searchParams.get('list')) return { kind: 'yt-playlist', url: rawUrl };
    if (u.pathname === '/watch' || u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/live/')) return { kind: 'yt-video', url: rawUrl };
    return { kind: 'generic', url: rawUrl };
  }

  if (host === 'soundcloud.com' || host === 'on.soundcloud.com') {
    if (u.pathname.includes('/sets/')) return { kind: 'sc-set', url: rawUrl };
    return { kind: 'sc-track', url: rawUrl };
  }

  return { kind: 'generic', url: rawUrl };
}

// Pull every Spotify track id out of a blob of pasted text. Spotify's own
// apps put one link per line when you select tracks and copy, so this is how
// a playlist of any size gets in: Spotify does the listing, we do the rest.
function trackIdsFromText(text) {
  const ids = [];
  const seen = new Set();
  const re = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/|spotify:track:)([A-Za-z0-9]{22})/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
  }
  return ids;
}

// Everything that is not a Spotify track link, one entry per whitespace-run.
function otherLinksFromText(text) {
  return String(text || '')
    .split(/\s+/)
    .filter((u) => /^https?:\/\//i.test(u))
    .filter((u) => !/(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/|spotify:track:)[A-Za-z0-9]{22}/.test(u));
}

function hostOf(rawUrl) {
  try { return new URL(rawUrl).hostname; } catch { return 'unknown'; }
}

function bestThumb(entry) {
  if (entry.thumbnail) return entry.thumbnail;
  const t = entry.thumbnails;
  if (Array.isArray(t) && t.length) return t[t.length - 1].url || null;
  return null;
}

function entryUnavailable(entry) {
  if (!entry) return 'This entry could not be read from the playlist';
  const t = String(entry.title || '');
  if (/^\[?private video\]?$/i.test(t)) return 'This video is private';
  if (/^\[?deleted video\]?$/i.test(t)) return 'This video was deleted';
  if (entry.availability && entry.availability !== 'public' && entry.availability !== 'unlisted') {
    return `Not available (${entry.availability})`;
  }
  return null;
}

function watchUrl(entry) {
  if (entry.url && /^https?:/i.test(entry.url)) return entry.url;
  if (entry.id) return `https://www.youtube.com/watch?v=${entry.id}`;
  return null;
}

// ---------- yt-dlp-backed sources (YouTube / SoundCloud / generic) ----------

async function expandViaYtdlp(url, wantPlaylist, kindLabel, ctx) {
  const host = hostOf(url);
  const fetchJson = async () => {
    await ctx.limiter.take(host);
    const args = wantPlaylist
      ? ['--flat-playlist', '-J', '--no-warnings', '--socket-timeout', '30', url]
      : ['--no-playlist', '-J', '--no-warnings', '--socket-timeout', '30', url];
    return ctx.tools.runYtdlpJson(args, { timeoutMs: 180000 });
  };

  let j = await fetchJson();
  let warning = null;

  if (j._type === 'playlist' || Array.isArray(j.entries)) {
    let entries = j.entries || [];
    let expected = j.playlist_count != null ? j.playlist_count : (j.n_entries != null ? j.n_entries : entries.length);

    // Never treat a short list as success: retry the expansion once, then warn.
    if (entries.length !== expected) {
      j = await fetchJson();
      entries = j.entries || [];
      expected = j.playlist_count != null ? j.playlist_count : (j.n_entries != null ? j.n_entries : entries.length);
      if (entries.length !== expected) {
        warning = `The source reports ${expected} tracks but only ${entries.length} could be listed — ${Math.abs(expected - entries.length)} are unaccounted for. The listed tracks were queued.`;
      }
    }

    const sourceKind = /soundcloud/i.test(host) ? 'soundcloud' : (/youtu/i.test(host) ? 'youtube' : 'other');
    const rows = entries.map((e, i) => {
      const unavailable = entryUnavailable(e);
      const row = manifest.makeRow({
        sourceKind,
        sourceUrl: e ? watchUrl(e) : null,
        sourceTitle: (e && e.title) || `Track ${i + 1}`,
        sourceUploader: (e && (e.uploader || e.channel)) || null,
        sourceThumb: e ? bestThumb(e) : null,
        sourceDurationSec: e && e.duration != null ? Math.round(e.duration) : null,
      });
      if (unavailable) {
        row.status = 'failed';
        row.error = unavailable;
      }
      return row;
    });

    return { title: j.title || `${kindLabel} (${rows.length})`, rows, warning };
  }

  // Single item
  const sourceKind = /soundcloud/i.test(host) ? 'soundcloud' : (/youtu/i.test(host) ? 'youtube' : 'other');
  const row = manifest.makeRow({
    sourceKind,
    sourceUrl: j.webpage_url || url,
    sourceTitle: j.title || url,
    sourceUploader: j.uploader || j.channel || null,
    sourceThumb: bestThumb(j),
    sourceDurationSec: j.duration != null ? Math.round(j.duration) : null,
  });
  return { title: j.title || 'Track', rows: [row], warning: null };
}

// ---------- Spotify sources: perfect metadata before we start ----------

function spotifyRow(track, artSize) {
  const meta = metaFromTrack(track, artSize);
  return manifest.makeRow({
    sourceKind: 'spotify',
    sourceTitle: `${meta.artist} — ${meta.title}`,
    sourceDurationSec: meta.durationMs ? Math.round(meta.durationMs / 1000) : null,
    needsResolve: true,   // audio found later, from YouTube — never from Spotify
    meta,
    matched: true,
    matchMode: 'matched',
  });
}

async function expandSpotify(kind, id, ctx) {
  if (!ctx.spotify.hasCreds()) {
    throw new CrateError('auth', 'Spotify links need API credentials — add a client ID and secret in Settings › Metadata');
  }
  const artSize = ctx.settings.get().artSize;

  if (kind === 'spotify-track') {
    const t = await ctx.spotify.getTrack(id);
    return { title: t.name || 'Spotify track', rows: [spotifyRow(t, artSize)], warning: null };
  }

  if (kind === 'spotify-album') {
    const { album, tracks } = await ctx.spotify.getAlbum(id);
    const expected = album.total_tracks || tracks.length;
    let warning = null;
    if (tracks.filter(Boolean).length !== expected) {
      warning = `Spotify reports ${expected} tracks on this album but ${tracks.filter(Boolean).length} were returned.`;
    }
    const rows = tracks.map((t, i) => {
      if (!t) {
        const row = manifest.makeRow({ sourceKind: 'spotify', sourceTitle: `${album.name} — track ${i + 1}` });
        row.status = 'failed';
        row.error = 'This track could not be read from Spotify';
        return row;
      }
      return spotifyRow(t, artSize);
    });
    return { title: `${(album.artists && album.artists[0] && album.artists[0].name) || ''} — ${album.name}`.replace(/^ — /, ''), rows, warning };
  }

  if (kind === 'spotify-playlist') {
    const { name, total, items, embedCapped } = await ctx.spotify.getPlaylist(id);
    let warning = null;
    if (items.length !== total) {
      warning = `Spotify reports ${total} tracks in this playlist but only ${items.length} were returned — ${Math.abs(total - items.length)} unaccounted for.`;
    } else if (embedCapped) {
      warning = 'Only the first 100 tracks could be read — Spotify refuses playlist listings to this app and hides the rest from outside apps. '
        + 'If the playlist is longer: open it in Spotify, click a track, press Ctrl+A then Ctrl+C, and paste the whole block here — that route has no limit.';
    }
    const rows = items.map((item, i) => {
      if (!item || !item.track || !item.track.id) {
        const label = item && item._embedTitle
          ? `${item._embedTitle}${item._embedArtists ? ' — ' + item._embedArtists : ''}`
          : `${name} — item ${i + 1}`;
        const row = manifest.makeRow({ sourceKind: 'spotify', sourceTitle: label });
        row.status = 'failed';
        row.error = item && item.is_local
          ? 'Local file in the playlist — not on Spotify, nothing to look up'
          : 'No longer available on Spotify (removed or region-blocked)';
        return row;
      }
      return spotifyRow(item.track, artSize);
    });
    return { title: name, rows, warning };
  }

  throw new CrateError('permanent', 'Unrecognised Spotify link');
}

// A pasted set of track links becomes a single batch, fetched one track at a
// time because this app's Spotify credentials are refused the batch endpoint.
// Responses are cached, so re-pasting the same list costs almost nothing.
async function expandTrackIds(ids, ctx) {
  if (!ctx.spotify.hasCreds()) {
    throw new CrateError('auth', 'Spotify links need API credentials — add a client ID and secret in Settings › Metadata');
  }
  const artSize = ctx.settings.get().artSize;
  const rows = [];
  let done = 0;
  for (const id of ids) {
    try {
      const t = await ctx.spotify.getTrack(id);
      rows.push(t && t.id ? spotifyRow(t, artSize) : deadRow('This track could not be read from Spotify'));
    } catch (err) {
      if (err.kind === 'ratelimit' || err.kind === 'auth') throw err;
      rows.push(deadRow(err.message || 'This track could not be read from Spotify'));
    }
    done += 1;
    if (ctx.onProgress && (done % 10 === 0 || done === ids.length)) {
      ctx.onProgress(`Reading track ${done} of ${ids.length} from Spotify...`);
    }
  }
  return { title: `${ids.length} tracks from Spotify`, rows, warning: null };
}

function deadRow(reason) {
  const row = manifest.makeRow({ sourceKind: 'spotify', sourceTitle: 'Unknown track' });
  row.status = 'failed';
  row.error = reason;
  return row;
}

// ---------- entry point ----------

async function expandLink(url, ctx, preBuilt) {
  const c = preBuilt ? { kind: 'prebuilt' } : classify(url);

  if (c.kind === 'invalid') throw new CrateError('permanent', "That doesn't look like a link — paste a track, album or playlist URL");
  if (c.kind === 'unsupported-spotify') throw new CrateError('permanent', 'Only Spotify track, album and playlist links are supported');

  let result;
  if (preBuilt) {
    result = preBuilt;
  } else if (c.kind.startsWith('spotify-')) {
    result = await expandSpotify(c.kind, c.id, ctx);
  } else if (c.kind === 'yt-playlist' || c.kind === 'sc-set') {
    result = await expandViaYtdlp(c.url, true, c.kind === 'sc-set' ? 'SoundCloud set' : 'YouTube playlist', ctx);
  } else {
    result = await expandViaYtdlp(c.url, false, 'Link', ctx);
  }

  // Rows arrive as `loaded` — nothing downloads until the user presses
  // Download. Unavailable entries stay failed so the gap is visible.
  for (const r of result.rows) {
    if (r.status === 'pending') r.status = 'loaded';
  }

  // Which of these are already on disk? Decided before a single byte of
  // audio is fetched, by content rather than by file name, so tracks saved
  // under another tool's naming are still recognised.
  let alreadyHave = 0;
  const s = ctx.settings.get();
  if (s.skipExisting && ctx.library) {
    if (ctx.onProgress) ctx.onProgress('Checking what you already have...');
    const indexes = await ctx.library.ensureAll(
      [s.outputDir, ...(s.extraLibraryDirs || [])],
      (done, total) => ctx.onProgress && ctx.onProgress(`Reading your library: ${done} of ${total} files...`)
    );
    for (const r of result.rows) {
      if (r.status !== 'loaded' || !r.meta || !r.meta.title) continue;
      const hit = ctx.library.findAny(indexes, r.meta);
      if (!hit) continue;
      r.status = 'skipped';
      r.filePath = hit.file;
      r.note = 'Already in your library (matched by ' + hit.how + ')';
      alreadyHave += 1;
    }
  }

  // Chunked-playlist workflow: the same track pasted twice (overlapping
  // chunks, re-pasted links) is marked as a duplicate, not downloaded twice.
  const seenIds = new Set();
  const seenUrls = new Set();
  for (const r of manifest.rows()) {
    if (r.status === 'failed') continue;
    if (r.meta && r.meta.spotifyId) seenIds.add(r.meta.spotifyId);
    if (r.sourceUrl) seenUrls.add(r.sourceUrl);
  }
  for (const r of result.rows) {
    if (r.status !== 'loaded') continue; // keep the "already in library" note
    const sid = r.meta && r.meta.spotifyId;
    if ((sid && seenIds.has(sid)) || (r.sourceUrl && seenUrls.has(r.sourceUrl))) {
      r.status = 'skipped';
      r.note = 'Duplicate — already in the queue';
    } else {
      if (sid) seenIds.add(sid);
      if (r.sourceUrl) seenUrls.add(r.sourceUrl);
    }
  }

  // The manifest is written to disk before any download starts.
  const batch = manifest.addBatch({ title: result.title, sourceUrl: url, expected: result.rows.length }, result.rows);
  manifest.saveNow();

  const unavailable = result.rows.filter((r) => r.status === 'failed').length;
  const toDownload = result.rows.filter((r) => r.status === 'loaded').length;
  return {
    ok: true,
    batchId: batch.id,
    title: result.title,
    added: result.rows.length,
    alreadyHave,
    toDownload,
    unavailable,
    warning: result.warning,
  };
}

module.exports = { expandLink, expandTrackIds, classify, trackIdsFromText, otherLinksFromText };
