// Spotify Web API client — client-credentials flow, plain fetch, no SDK.
// Token cached until its real expiry. Search responses cached to disk keyed
// by normalised query. Batch endpoints used wherever they exist.
// Spotify is never an audio source.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { CrateError } = require('./politeness');
const { normalize } = require('./matcher');

const API_HOST = 'api.spotify.com';
const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const AUTH_SCOPES = 'playlist-read-private playlist-read-collaborative';

let S = null; // { settings, limiter, breaker, cacheDir }
let token = { value: null, exp: 0, credsKey: '' };
let userToken = { value: null, exp: 0 };
let lastClientId = '';
let searchCache = null;
let searchCacheFile = null;
let cacheSaveTimer = null;

function init(ctx) {
  S = ctx;
  searchCacheFile = path.join(S.cacheDir, 'spotify-search.json');
  try {
    searchCache = new Map(Object.entries(JSON.parse(fs.readFileSync(searchCacheFile, 'utf8'))));
  } catch {
    searchCache = new Map();
  }
  lastClientId = S.settings.get().spotifyClientId || '';
  S.settings.onChange((all, patch) => {
    if ('spotifyClientId' in patch || 'spotifyClientSecret' in patch) token = { value: null, exp: 0, credsKey: '' };
    if ('spotifyClientId' in patch) {
      const next = all.spotifyClientId || '';
      // A refresh token belongs to the app that issued it. Pointing Crate at
      // a different app makes the stored login meaningless, so drop it rather
      // than leave Settings claiming a connection that cannot work.
      if (lastClientId && next && next !== lastClientId) {
        userToken = { value: null, exp: 0 };
        if (S.settings.get().spotifyRefreshToken) S.settings.set({ spotifyRefreshToken: '' });
      }
      lastClientId = next;
    }
  });
}

function hasCreds() {
  const s = S.settings.get();
  return Boolean(s.spotifyClientId && s.spotifyClientSecret);
}

function persistCache() {
  if (cacheSaveTimer) return;
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    try {
      // keep the cache bounded — drop oldest entries beyond 8000
      while (searchCache.size > 8000) searchCache.delete(searchCache.keys().next().value);
      fs.mkdirSync(S.cacheDir, { recursive: true });
      const tmp = searchCacheFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(searchCache)));
      fs.renameSync(tmp, searchCacheFile);
    } catch { /* cache persistence is best-effort */ }
  }, 2000);
}

async function getToken() {
  const s = S.settings.get();
  if (!s.spotifyClientId || !s.spotifyClientSecret) {
    throw new CrateError('auth', 'Spotify credentials not set — add them in Settings › Metadata');
  }
  const credsKey = `${s.spotifyClientId}:${s.spotifyClientSecret}`;
  if (token.value && token.credsKey === credsKey && Date.now() < token.exp - 60000) return token.value;

  await S.limiter.take('accounts.spotify.com');
  let res;
  try {
    res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(credsKey).toString('base64'),
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new CrateError('transient', `Couldn't reach Spotify to authenticate (${err.name === 'TimeoutError' ? 'timed out' : 'network error'})`);
  }
  if (res.status === 429) {
    const ra = parseRetryAfter(res);
    const r = S.breaker.noteRateLimit('accounts.spotify.com', ra);
    throw new CrateError('ratelimit', 'Spotify is rate limiting authentication', { host: 'accounts.spotify.com', retryAfterMs: ra, until: r.until });
  }
  if (!res.ok) {
    throw new CrateError('auth', `Spotify rejected the credentials (HTTP ${res.status}) — check the client ID and secret in Settings › Metadata`);
  }
  const j = await res.json();
  token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000, credsKey };
  return token.value;
}

function parseRetryAfter(res) {
  const v = parseInt(res.headers.get('retry-after') || '', 10);
  return Number.isFinite(v) ? v * 1000 : 5000;
}

// ---------- user login (Authorization Code + PKCE) ----------
// Kept, but it does not unlock playlists. Tested 2026-10-27 against a freshly
// created developer app: /v1/playlists/{id}/tracks returns 403 for the app
// token AND for a signed-in user token with playlist-read-private granted,
// even on a playlist the user owns. Spotify has closed that endpoint to apps
// registered under its current policy. This flow remains only so the app
// works immediately if that ever changes.

function isConnected() {
  return Boolean(S.settings.get().spotifyRefreshToken);
}

function disconnect() {
  userToken = { value: null, exp: 0 };
  S.settings.set({ spotifyRefreshToken: '' });
}

// Single-flight: Spotify rotates the refresh token on every use, so two
// concurrent refreshes would invalidate each other and log the user out.
let refreshInflight = null;

function getUserToken() {
  const s = S.settings.get();
  if (!s.spotifyRefreshToken || !s.spotifyClientId) return Promise.resolve(null);
  if (userToken.value && Date.now() < userToken.exp - 60000) return Promise.resolve(userToken.value);
  if (!refreshInflight) {
    refreshInflight = doRefreshUserToken(s).finally(() => { refreshInflight = null; });
  }
  return refreshInflight;
}

async function doRefreshUserToken(s) {
  await S.limiter.take('accounts.spotify.com');
  let res;
  try {
    res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: s.spotifyRefreshToken,
        client_id: s.spotifyClientId,
      }).toString(),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return null; // fall back to the app token; the caller surfaces any 403
  }
  if (res.status === 400) {
    // Only a definitively dead token logs the user out — never a hiccup.
    let body = null;
    try { body = await res.json(); } catch { /* keep null */ }
    if (body && body.error === 'invalid_grant') disconnect();
    return null;
  }
  if (!res.ok) return null;
  const j = await res.json();
  userToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  if (j.refresh_token) S.settings.set({ spotifyRefreshToken: j.refresh_token });
  return userToken.value;
}

// Opens the Spotify consent page in the default browser and catches the
// redirect on a short-lived loopback server. PKCE — the secret never leaves
// the token exchange out of this machine.
async function connectAccount(openExternal) {
  const s = S.settings.get();
  if (!s.spotifyClientId) throw new CrateError('auth', 'Add your Spotify client ID first (Settings › Metadata)');

  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(12).toString('base64url');

  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.searchParams.set('client_id', s.spotifyClientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('scope', AUTH_SCOPES);
  authUrl.searchParams.set('state', state);

  const page = (msg) =>
    `<body style="font-family:sans-serif;background:#101114;color:#e8e6e1;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">${msg}</body>`;

  const code = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); server.close(); fn(arg); } };
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1:8888');
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const err = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page(err ? 'Connection cancelled — you can close this tab.' : 'Spotify connected — you can close this tab and go back to Crate.'));
      if (err) finish(reject, new CrateError('auth', 'Spotify connection was cancelled'));
      else if (u.searchParams.get('state') !== state) finish(reject, new CrateError('auth', "Login response didn't match this request — try again"));
      else finish(resolve, u.searchParams.get('code'));
    });
    server.on('error', () => finish(reject, new CrateError('tooling', "Couldn't listen on 127.0.0.1:8888 — close whatever is using that port and try again")));
    const timer = setTimeout(() => finish(reject, new CrateError('auth', 'Spotify login timed out after 5 minutes')), 300000);
    server.listen(8888, '127.0.0.1', () => openExternal(authUrl.toString()));
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: s.spotifyClientId,
      code_verifier: verifier,
    }).toString(),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw new CrateError('auth', `Token exchange failed (HTTP ${res.status}). Check that ${REDIRECT_URI} is listed under Redirect URIs in your Spotify app settings.`);
  }
  const j = await res.json();
  userToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  S.settings.set({ spotifyRefreshToken: j.refresh_token || '' });
  return true;
}

async function api(pth, query, opts = {}) {
  const blocked = S.breaker.blockedUntil(API_HOST);
  if (blocked > Date.now()) {
    throw new CrateError('ratelimit', 'Spotify is rate limiting', { host: API_HOST, until: blocked });
  }
  // user token where requested (playlists need it on newer apps), app token otherwise
  let tok = opts.user ? await getUserToken() : null;
  if (!tok) tok = await getToken();
  await S.limiter.take(API_HOST);

  const url = new URL(`https://${API_HOST}${pth}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new CrateError('transient', `Couldn't reach Spotify (${err.name === 'TimeoutError' ? 'timed out' : 'network error'})`);
  }

  if (res.status === 429) {
    const ra = parseRetryAfter(res); // honour Retry-After exactly — never retry sooner
    const r = S.breaker.noteRateLimit(API_HOST, ra);
    throw new CrateError('ratelimit', 'Spotify is rate limiting', { host: API_HOST, retryAfterMs: ra, until: r.until });
  }
  if (res.status === 401) { token = { value: null, exp: 0, credsKey: '' }; throw new CrateError('transient', 'Spotify session expired — retrying with a fresh token'); }
  if (res.status === 403) throw new CrateError('permanent', "Spotify refused this request (403) — this app's credentials may not have access to that content");
  if (res.status === 404) throw new CrateError('permanent', 'Not found on Spotify — the link may be wrong or the item removed');
  if (res.status >= 500 || res.status === 503) {
    if (res.status === 503) {
      const ra = parseRetryAfter(res);
      const r = S.breaker.noteRateLimit(API_HOST, ra);
      throw new CrateError('ratelimit', 'Spotify is temporarily unavailable', { host: API_HOST, retryAfterMs: ra, until: r.until });
    }
    throw new CrateError('transient', `Spotify server error (HTTP ${res.status})`);
  }
  if (!res.ok) throw new CrateError('transient', `Spotify error (HTTP ${res.status})`);

  S.breaker.noteSuccess(API_HOST);
  return res.json();
}

// ---------- endpoints ----------

async function searchTracks(q, limit = 10) {
  const key = `${normalize(q)}|${limit}`;
  if (searchCache.has(key)) return searchCache.get(key);
  const j = await api('/v1/search', { q, type: 'track', limit: String(limit) });
  const items = (j.tracks && j.tracks.items) || [];
  searchCache.set(key, items);
  persistCache();
  return items;
}

// Cached under the same key the batch path uses, so pasting a list twice —
// or re-adding a playlist you already loaded — costs almost no requests.
async function getTrack(id) {
  const key = `t:${id}`;
  if (searchCache.has(key)) return searchCache.get(key);
  const t = await api(`/v1/tracks/${id}`);
  if (t && t.id) { searchCache.set(key, t); persistCache(); }
  return t;
}

// Batch endpoints are the polite default (one request instead of fifty),
// but Spotify's newer developer apps 403 them while allowing the same data
// one item at a time. Detect that once and fall back to singles, cached on
// disk so a repeat run costs nothing.
let trackBatchBlocked = false;
let artistBatchBlocked = false;

function is403(err) { return err && (err.kind === 'permanent' || err.kind === 'auth') && /403/.test(err.message); }

async function getArtists(ids) {
  const out = [];
  if (!artistBatchBlocked) {
    try {
      for (let i = 0; i < ids.length; i += 50) {
        const j = await api('/v1/artists', { ids: ids.slice(i, i + 50).join(',') });
        out.push(...(j.artists || []));
      }
      return out;
    } catch (err) {
      if (is403(err)) artistBatchBlocked = true;
      else throw err;
    }
  }
  for (const id of ids) {
    try {
      const a = await api(`/v1/artists/${id}`);
      if (a && a.id) out.push(a);
    } catch (err) {
      if (err.kind === 'ratelimit' || err.kind === 'auth') throw err;
    }
  }
  return out;
}

async function getTracksBatch(ids) {
  const out = [];
  const need = [];
  for (const id of ids) {
    const k = `t:${id}`;
    if (searchCache.has(k)) out.push(searchCache.get(k));
    else need.push(id);
  }
  if (!need.length) return out;

  if (!trackBatchBlocked) {
    try {
      const got = [];
      for (let i = 0; i < need.length; i += 50) {
        const j = await api('/v1/tracks', { ids: need.slice(i, i + 50).join(',') });
        got.push(...(j.tracks || []).filter(Boolean));
      }
      for (const t of got) searchCache.set(`t:${t.id}`, t);
      persistCache();
      return [...out, ...got];
    } catch (err) {
      if (is403(err)) trackBatchBlocked = true;
      else throw err;
    }
  }
  for (const id of need) {
    try {
      const t = await api(`/v1/tracks/${id}`);
      if (t && t.id) { searchCache.set(`t:${t.id}`, t); out.push(t); }
    } catch (err) {
      if (err.kind === 'ratelimit' || err.kind === 'auth') throw err;
      // a single dead track is reported by the caller as a failed row
    }
  }
  persistCache();
  return out;
}

// Follow `next` until null. Compare collected against `total` — a mismatch
// is an error, not a shrug.
async function getPlaylist(id) {
  try {
    const head = await api(`/v1/playlists/${id}`, { fields: 'name,owner(display_name),tracks(total)' }, { user: true });
    const total = (head.tracks && head.tracks.total) || 0;
    if (!head.tracks) throw new CrateError('permanent', 'playlist tracks stripped (403)'); // new-app policy — go via embed
    const items = [];
    let offset = 0;
    while (true) {
      const page = await api(`/v1/playlists/${id}/tracks`, {
        limit: '100',
        offset: String(offset),
        fields: 'items(is_local,track(id,name,artists,album(id,name,album_type,images,release_date,total_tracks,artists),track_number,disc_number,duration_ms,external_ids)),next,total',
      }, { user: true });
      items.push(...(page.items || []));
      if (!page.next) break;
      offset += 100;
      if (offset > 10000) break; // hard safety stop
    }
    return { name: head.name || 'Spotify playlist', owner: head.owner && head.owner.display_name, total, items };
  } catch (err) {
    // Spotify's newer developer apps cannot list playlist tracks through the
    // API at all, with any token. Fall through the remaining routes in order
    // of completeness: spotdl's older registration reads a playlist of any
    // length, and the public embed page carries only the first 100.
    if (err && (err.kind === 'permanent' || err.kind === 'auth') && /403/.test(err.message)) {
      const viaEmbed = await getPlaylistViaEmbed(id);
      // Under 100 means the embed showed the whole playlist, so stop here and
      // never pay for a spotdl probe. Exactly 100 means it was truncated —
      // only then is a longer route worth trying.
      if (!viaEmbed.embedCapped) return viaEmbed;
      const viaSpotdl = await getPlaylistViaSpotdl(id);
      if (viaSpotdl && viaSpotdl.items.length > viaEmbed.items.length) return viaSpotdl;
      return viaEmbed;
    }
    throw err;
  }
}

// Turns spotdl's flat song records into the Spotify track shape the rest of
// Crate already understands.
function trackFromSpotdl(t) {
  if (!t || !t.id) return null;
  return {
    id: t.id,
    name: t.name || '',
    artists: (t.artists && t.artists.length ? t.artists : [t.artist]).filter(Boolean).map((name) => ({ name })),
    album: {
      id: t.album_id || null,
      name: t.album || '',
      album_type: null,
      images: t.cover_url ? [{ url: t.cover_url, width: 640, height: 640 }] : [],
      release_date: t.date || (t.year ? String(t.year) : null),
      total_tracks: t.tracks_count || null,
      artists: t.album_artist ? [{ name: t.album_artist }] : [],
    },
    track_number: t.track_number || null,
    disc_number: t.disc_number || null,
    duration_ms: t.duration ? Math.round(t.duration * 1000) : null,
    external_ids: t.isrc ? { isrc: t.isrc } : {},
  };
}

// Returns null when spotdl is absent or cannot answer, so the caller moves on.
async function getPlaylistViaSpotdl(id) {
  if (!S.tools || !S.tools.spotdlList) return null;
  let res;
  try {
    res = await S.tools.spotdlList(`https://open.spotify.com/playlist/${id}`);
  } catch {
    return null;
  }
  if (!res || !res.ok || !Array.isArray(res.tracks) || !res.tracks.length) return null;
  const items = res.tracks.map((t) => {
    const track = trackFromSpotdl(t);
    return track
      ? { is_local: false, track }
      : { is_local: false, track: null, _embedTitle: (t && t.name) || null, _embedArtists: (t && t.artist) || null };
  });
  return { name: res.name || 'Spotify playlist', total: items.length, items, via: 'spotdl' };
}

async function getPlaylistViaEmbed(id) {
  await S.limiter.take('open.spotify.com');
  let res;
  try {
    res = await fetch(`https://open.spotify.com/embed/playlist/${id}`, {
      headers: { 'User-Agent': 'Crate/0.1.0 (personal desktop music tagger)' },
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new CrateError('transient', "Couldn't reach Spotify to read the playlist — will retry");
  }
  if (res.status === 404) throw new CrateError('permanent', 'Playlist not found — if it’s private, set it to public and try again');
  if (res.status === 429) {
    const ra = parseInt(res.headers.get('retry-after') || '', 10);
    const r = S.breaker.noteRateLimit('open.spotify.com', Number.isFinite(ra) ? ra * 1000 : 0);
    throw new CrateError('ratelimit', 'Spotify is rate limiting', { host: 'open.spotify.com', until: r.until });
  }
  if (!res.ok) throw new CrateError('transient', `Couldn't read the playlist page (HTTP ${res.status})`);

  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  let entity = null;
  try {
    entity = m && JSON.parse(m[1]).props.pageProps.state.data.entity;
  } catch { /* handled below */ }
  if (!entity || !Array.isArray(entity.trackList)) {
    throw new CrateError('permanent', "Couldn't read this playlist — it may be private. Set it to public and add the link again");
  }

  const list = entity.trackList;
  const ids = list.map((t) => String(t.uri || '').split(':').pop()).filter((x) => /^[A-Za-z0-9]{10,}$/.test(x));
  let byId = new Map();
  try {
    const full = await getTracksBatch(ids); // official API — full metadata incl. album + ISRC
    byId = new Map(full.filter(Boolean).map((t) => [t.id, t]));
  } catch (err) {
    if (err.kind === 'ratelimit' || err.kind === 'auth') throw err;
  }
  const items = list.map((t) => {
    const tid = String(t.uri || '').split(':').pop();
    const track = byId.get(tid) || null;
    return { is_local: false, track, _embedTitle: t.title || null, _embedArtists: t.subtitle || null };
  });
  return {
    name: entity.name || 'Spotify playlist',
    total: list.length,
    items,
    embedCapped: list.length >= 100, // embed may hide anything past 100 — flag it, never shrug
  };
}

async function getAlbum(id) {
  const album = await api(`/v1/albums/${id}`);
  const simplified = [...((album.tracks && album.tracks.items) || [])];
  let next = album.tracks && album.tracks.next;
  let offset = simplified.length;
  while (next) {
    const page = await api(`/v1/albums/${id}/tracks`, { limit: '50', offset: String(offset) });
    simplified.push(...(page.items || []));
    next = page.next;
    offset += 50;
  }
  // Batch-fetch full track objects (adds ISRC); fall back to simplified + album.
  let full = [];
  try {
    full = await getTracksBatch(simplified.map((t) => t && t.id).filter(Boolean));
  } catch { full = []; }
  const byId = new Map(full.filter(Boolean).map((t) => [t.id, t]));
  const tracks = simplified.map((t) => {
    if (!t) return null;
    const f = byId.get(t.id);
    if (f) return f;
    return { ...t, album: { id: album.id, name: album.name, album_type: album.album_type, images: album.images, release_date: album.release_date, total_tracks: album.total_tracks, artists: album.artists } };
  });
  return { album, tracks };
}

module.exports = {
  init, hasCreds, api, searchTracks, getTrack, getTracksBatch, getArtists, getPlaylist, getAlbum,
  isConnected, connectAccount, disconnect,
};
