// Genre lookup. Accuracy over coverage: a wrong genre is worse than no
// genre, so only two trusted sources are used — MusicBrainz's curated genre
// list (specific: "garage house", "acid house", "deep house") and, as a
// fallback, the artist's Spotify genres. Vocabulary-validated MB tags fill
// the gap when a recording has tags but no formal genres.
//
// MusicBrainz asks for 1 request/second and a real User-Agent — both
// honoured here through the shared limiter.
'use strict';

const fs = require('fs');
const path = require('path');
const { normalize } = require('./matcher');

const MB_HOST = 'musicbrainz.org';
const UA = 'Crate/0.1.0 (personal desktop music tagger)';

// Broad labels lose to specific ones when both are present.
const GENERIC = new Set([
  'electronic', 'electronica', 'dance', 'edm', 'pop', 'rock', 'alternative',
  'indie', 'music', 'other', 'unknown',
]);

// Vocabulary used ONLY to validate free-form MB tags (formal MB genres and
// Spotify genres are already curated). Multi-word first-class citizens.
const GENRE_VOCAB = new Set([
  // house and friends
  'house', 'deep house', 'garage house', 'jazz house', 'acid house', 'chicago house',
  'classic house', 'rally house',
  'tech house', 'progressive house', 'tribal house', 'french house', 'italo house',
  'electro house', 'afro house', 'funky house', 'soulful house', 'disco house',
  'filter house', 'microhouse', 'bass house', 'future house', 'big room house',
  'lo-fi house', 'outsider house', 'ambient house', 'hard house', 'latin house',
  'vocal house', 'piano house', 'organ house', 'us garage', 'garage',
  // garage / uk lineage
  'uk garage', '2-step', 'speed garage', 'future garage', 'bassline', 'uk funky',
  // techno
  'techno', 'detroit techno', 'minimal techno', 'dub techno', 'acid techno',
  'hard techno', 'industrial techno', 'ambient techno', 'melodic techno',
  // other electronic
  'electro', 'breakbeat', 'big beat', 'jungle', 'drum and bass', 'liquid funk',
  'neurofunk', 'dubstep', 'brostep', 'grime', 'trance', 'progressive trance',
  'psytrance', 'goa trance', 'hard trance', 'uplifting trance', 'hardstyle',
  'gabber', 'happy hardcore', 'ambient', 'dark ambient', 'downtempo', 'trip hop',
  'idm', 'glitch', 'breakcore', 'footwork', 'juke', 'baltimore club', 'jersey club',
  'synthwave', 'vaporwave', 'chillwave', 'electroclash', 'ebm', 'industrial',
  'leftfield', 'balearic beat', 'acid jazz', 'broken beat', 'nu jazz',
  'future jazz', 'rave', 'experimental', 'hardcore', 'oldschool jungle',
  // disco / funk / soul
  'disco', 'nu-disco', 'italo-disco', 'boogie', 'funk', 'p-funk', 'soul',
  'neo soul', 'northern soul', 'philly soul', 'motown', 'gospel',
  // hip hop / r&b
  'hip hop', 'rap', 'boom bap', 'trap', 'drill', 'g-funk', 'conscious hip hop',
  'instrumental hip hop', 'lo-fi hip hop', 'r&b', 'contemporary r&b', 'new jack swing',
  // jazz
  'jazz', 'jazz-funk', 'jazz fusion', 'smooth jazz', 'bebop', 'hard bop',
  'free jazz', 'modal jazz', 'swing', 'big band', 'bossa nova', 'latin jazz',
  'spiritual jazz', 'cool jazz', 'soul jazz',
  // rock / pop lineage
  'blues', 'blues rock', 'rock and roll', 'hard rock', 'psychedelic rock',
  'progressive rock', 'post-rock', 'krautrock', 'punk', 'post-punk', 'new wave',
  'synth-pop', 'dream pop', 'shoegaze', 'grunge', 'indie rock', 'indie pop',
  'art pop', 'power pop', 'garage rock', 'surf rock', 'folk rock', 'soft rock',
  'yacht rock', 'city pop', 'j-pop', 'k-pop', 'britpop', 'emo', 'metal',
  'heavy metal', 'doom metal', 'black metal', 'death metal', 'thrash metal',
  // roots / world
  'reggae', 'dub', 'dancehall', 'ska', 'rocksteady', 'roots reggae', 'afrobeat',
  'afrobeats', 'amapiano', 'highlife', 'soca', 'calypso', 'cumbia', 'salsa',
  'samba', 'mpb', 'flamenco', 'fado', 'raï', 'gqom', 'kwaito', 'baile funk',
  // singer / acoustic / other
  'folk', 'americana', 'country', 'bluegrass', 'singer-songwriter', 'classical',
  'baroque', 'opera', 'minimalism', 'film score', 'musique concrète', 'new age',
]);

let S = null; // { settings, spotify, limiter, breaker, cacheDir }
let cache = null; // Map key -> { genre, source } | null
let cacheFile = null;
let saveTimer = null;

function init(ctx) {
  S = ctx;
  cacheFile = path.join(S.cacheDir, 'genre.json');
  try {
    cache = new Map(Object.entries(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))));
  } catch {
    cache = new Map();
  }
}

function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      while (cache.size > 20000) cache.delete(cache.keys().next().value);
      fs.mkdirSync(S.cacheDir, { recursive: true });
      const tmp = cacheFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(cache)));
      fs.renameSync(tmp, cacheFile);
    } catch { /* best effort */ }
  }, 2000);
}

// ---------- MusicBrainz ----------

async function mbGet(pth, params) {
  if (S.breaker.isBlocked(MB_HOST)) return null;
  await S.limiter.take(MB_HOST);
  const url = new URL(`https://${MB_HOST}/ws/2/${pth}`);
  url.searchParams.set('fmt', 'json');
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  } catch {
    return null; // genre lookup must never fail a track
  }
  if (res.status === 503 || res.status === 429) {
    const ra = parseInt(res.headers.get('retry-after') || '', 10);
    S.breaker.noteRateLimit(MB_HOST, Number.isFinite(ra) ? ra * 1000 : 0);
    return null;
  }
  if (!res.ok) return null;
  S.breaker.noteSuccess(MB_HOST);
  try { return await res.json(); } catch { return null; }
}

// Top matching recordings (best two) — different recordings of the same
// song carry different community data, so one empty result isn't the end.
// Also returns MB artist ids from the credits for the artist-genre fallback.
async function mbFindRecordings({ isrc, artist, title }) {
  let recs = [];
  if (isrc) {
    const j = await mbGet('recording', { query: `isrc:${isrc}`, limit: '3' });
    recs = (j && j.recordings) || [];
  }
  if (!recs.length && artist && title) {
    const q = `recording:"${title.replace(/"/g, '')}" AND artist:"${artist.replace(/"/g, '')}"`;
    const j = await mbGet('recording', { query: q, limit: '3' });
    recs = ((j && j.recordings) || []).filter((r) => (r.score || 0) >= 90);
  }
  return recs.slice(0, 2).map((r) => ({
    id: r.id,
    artistIds: (r['artist-credit'] || []).map((ac) => ac.artist && ac.artist.id).filter(Boolean),
  }));
}

// One lookup gets the recording's own genres/tags AND the ids of the
// release-groups (albums) it appears on, for the next fallback step.
async function mbRecordingData(recId) {
  const j = await mbGet(`recording/${recId}`, { inc: 'genres tags releases release-groups' });
  if (!j) return { genres: [], tags: [], rgIds: [] };
  const rgs = [];
  for (const rel of j.releases || []) {
    const rg = rel['release-group'];
    if (rg && rg.id) rgs.push({ id: rg.id, type: rg['primary-type'] || '' });
  }
  // proper releases first — a compilation's genre pool is muddier
  rgs.sort((a, b) => {
    const rank = (t) => (t === 'Album' || t === 'EP' || t === 'Single' ? 0 : 1);
    return rank(a.type) - rank(b.type);
  });
  const seen = new Set();
  const rgIds = [];
  for (const rg of rgs) {
    if (!seen.has(rg.id)) { seen.add(rg.id); rgIds.push(rg.id); }
  }
  return { genres: j.genres || [], tags: j.tags || [], rgIds };
}

// Recording-level genres are sparse; the release-group is far better
// populated (this is where most albums carry "french house", "uk garage"…).
async function mbReleaseGroupGenres(rgId) {
  const j = await mbGet(`release-group/${rgId}`, { inc: 'genres' });
  return ((j && j.genres) || []).map((g) => ({ name: g.name.toLowerCase(), count: g.count || 1 }));
}

async function mbArtistGenres(artistId) {
  const j = await mbGet(`artist/${artistId}`, { inc: 'genres' });
  return ((j && j.genres) || []).map((g) => ({ name: g.name.toLowerCase(), count: g.count || 1 }));
}

// The strongest signal when the track was Spotify-matched: we KNOW the album
// name, so find that exact release-group and use its genres directly.
async function mbFindAlbumGenres({ album, artist }) {
  if (!album || !artist) return [];
  const clean = album.replace(/"/g, '').replace(/\s*[([](deluxe|expanded|remaster(ed)?|anniversary|bonus|special)[^)\]]*[)\]]\s*$/i, '').trim();
  const q = `releasegroup:"${clean}" AND artist:"${artist.replace(/"/g, '')}"`;
  const j = await mbGet('release-group', { query: q, limit: '3' });
  const groups = ((j && j['release-groups']) || []).filter((rg) => (rg.score || 0) >= 90);
  for (const rg of groups) {
    const genres = await mbReleaseGroupGenres(rg.id);
    if (genres.length) return genres;
  }
  return [];
}

// ---------- selection ----------

// The user's own taxonomy: experimental/downtempo territory files under
// Triphop; anything drum-and-bass or rave-shaped files under Jungle.
const ALIASES = new Map([
  ['downtempo', 'Triphop'],
  ['trip hop', 'Triphop'],
  ['acid jazz', 'Triphop'],
  ['future jazz', 'Triphop'],
  ['nu jazz', 'Triphop'],
  ['leftfield', 'Triphop'],
  ['breakbeat', 'Triphop'],
  ['experimental', 'Triphop'],
  ['drum and bass', 'Jungle'],
  ['liquid funk', 'Jungle'],
  ['neurofunk', 'Jungle'],
  ['rave', 'Jungle'],
  ['jungle', 'Jungle'],
  ['oldschool jungle', 'Jungle'],
]);

function finalizeName(lowerName) {
  return ALIASES.get(lowerName) || titleCase(lowerName);
}

// Re-map cached results too, so a taxonomy change reaches old cache entries.
function applyAliases(result) {
  if (!result || !result.genre) return result;
  const mapped = ALIASES.get(result.genre.toLowerCase());
  return mapped && mapped !== result.genre ? { ...result, genre: mapped } : result;
}

function titleCase(g) {
  return String(g).split(/\s+/).map((w) =>
    /^(and|of|the)$/i.test(w) ? w.toLowerCase()
      : /^[a-z]?&[a-z]?$|^r&b$/i.test(w) ? w.toUpperCase()
      : w.length <= 3 && /^(idm|edm|ebm|mpb|uk|us|dnb)$/i.test(w) ? w.toUpperCase()
      : w.charAt(0).toUpperCase() + w.slice(1)
  ).join(' ');
}

// Community votes carry the decision; generic labels are heavily discounted
// and specific multi-word genres get a modest boost — so 2× "house" beats
// 1× "big beat", but "garage house" edges out "house" at similar votes.
function pickBest(cands) {
  if (!cands.length) return null;
  let best = null;
  let bestScore = 0;
  for (const c of cands) {
    const words = c.name.split(' ').length;
    const score = (c.count || 1) * (GENERIC.has(c.name) ? 0.3 : 1) * (1 + 0.4 * (words - 1));
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best ? best.name : null;
}

// ---------- Spotify artist genres (fallback) ----------

async function spotifyArtistGenres(artistIds) {
  if (!artistIds || !artistIds.length || !S.spotify.hasCreds()) return [];
  const need = [];
  const found = [];
  for (const id of artistIds.slice(0, 3)) {
    const k = `sa:${id}`;
    if (cache.has(k)) found.push(...(cache.get(k) || []));
    else need.push(id);
  }
  if (need.length) {
    try {
      const artists = await S.spotify.getArtists(need);
      for (const a of artists) {
        if (!a) continue;
        cache.set(`sa:${a.id}`, a.genres || []);
        found.push(...(a.genres || []));
      }
      persist();
    } catch { /* fallback source only — never fatal */ }
  }
  return found;
}

// ---------- entry point ----------

// -> { genre: 'Garage House', source: 'musicbrainz-…'|'spotify' } | null
async function forTrack({ isrc, artist, title, album, artistIds }) {
  const key = isrc ? `i:${isrc}` : `q:${normalize(artist)}|${normalize(title)}`;
  if (cache.has(key)) return applyAliases(cache.get(key));

  let result = null;

  // 0. the known album's release-group — deterministic when Spotify-matched
  if (album && artist) {
    const ag = pickBest(await mbFindAlbumGenres({ album, artist }));
    if (ag) result = { genre: finalizeName(ag), source: 'musicbrainz-album' };
  }

  const recs = result ? [] : await mbFindRecordings({ isrc, artist, title });
  const rgPool = [];
  const mbArtistIds = [];
  for (const rec of recs) {
    for (const a of rec.artistIds) if (!mbArtistIds.includes(a)) mbArtistIds.push(a);
    const { genres, tags, rgIds } = await mbRecordingData(rec.id);
    rgPool.push(...rgIds.filter((id) => !rgPool.includes(id)));
    // 1. formal MB genres on the recording — curated, trustworthy as-is
    const g = pickBest(genres.map((x) => ({ name: x.name.toLowerCase(), count: x.count || 1 })));
    if (g) { result = { genre: finalizeName(g), source: 'musicbrainz' }; break; }
    // 2. free-form recording tags, accepted only if in the genre vocabulary
    const t = pickBest(
      tags
        .map((x) => ({ name: x.name.toLowerCase(), count: x.count || 1 }))
        .filter((x) => GENRE_VOCAB.has(x.name))
    );
    if (t) { result = { genre: finalizeName(t), source: 'musicbrainz-tag' }; break; }
  }

  // 3. the release-groups (albums) the recording appears on — votes POOLED
  // across several releases so one oddly-tagged compilation can't win alone
  if (!result) {
    const pooled = new Map();
    for (const rgId of rgPool.slice(0, 4)) {
      for (const g of await mbReleaseGroupGenres(rgId)) {
        pooled.set(g.name, (pooled.get(g.name) || 0) + g.count);
      }
    }
    const rg = pickBest([...pooled.entries()].map(([name, count]) => ({ name, count })));
    if (rg) result = { genre: finalizeName(rg), source: 'musicbrainz-release' };
  }

  // 4. MB artist genres — well populated, still curated
  if (!result && mbArtistIds.length) {
    const ag = pickBest(await mbArtistGenres(mbArtistIds[0]));
    if (ag) result = { genre: finalizeName(ag), source: 'musicbrainz-artist' };
  }

  // 5. the artist's Spotify genres — less precise but broadly right
  if (!result) {
    const sg = await spotifyArtistGenres(artistIds);
    const g = pickBest(sg.map((name, i) => ({ name: name.toLowerCase(), count: sg.length - i })));
    if (g) result = { genre: finalizeName(g), source: 'spotify' };
  }

  cache.set(key, result); // nulls cached too — a miss stays a miss, no re-asking
  persist();
  return result;
}

module.exports = { init, forTrack, pickBest, titleCase, GENRE_VOCAB };
