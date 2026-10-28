// The metadata matcher — BRIEF.md §6. Parses messy source titles, searches
// Spotify, scores candidates (title 0.45, artist 0.30, duration 0.25), and
// picks the right *release* so the cover art is the original sleeve, not a
// compilation.
'use strict';

// ---------- normalisation ----------

// Fold case and strip diacritics for comparison only, never for output.
function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) { return normalize(s).split(' ').filter(Boolean); }

// Dice coefficient over token sets — order-insensitive.
function tokenSetRatio(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

// ---------- source-title parsing ----------

const VERSION_WORDS = /\b(remix|mix|edit|re-?edit|rework|remaster(?:ed)?|dub|version|bootleg|flip|vip|extended|radio|club|instrumental|acoustic|live|demo|refix)\b/i;

const NOISE_SEGMENT = new RegExp(
  '^(?:' + [
    'official\\s*(?:music\\s*)?(?:video|audio|visuali[sz]er|lyric\\s*video)',
    'officiell?\\s*video', 'video\\s*oficial', 'audio\\s*oficial',
    'hd|hq|4k|1080p?|720p?', 'lyrics?', 'with\\s+lyrics?', 'visuali[sz]er',
    'vinyl(?:\\s*rip)?', 'hq\\s*vinyl\\s*rip', 'full\\s*(?:album|ep|version)?',
    'free\\s*(?:download|dl)', 'out\\s*now.*', 'premiere.*', 'exclusive.*',
    'high\\s*quality', 'audio', 'video', 'clip\\s*officiel',
    '\\d{4}', 'new', 'copyright.*', 'no\\s*copyright.*', 'monstercat.*',
  ].join('|') + ')$', 'i'
);

// Preserve mix/version info — it identifies a distinct release. A remix
// matched to the original is a wrong answer, not a near-miss.
function stripNoise(title) {
  return String(title || '').replace(/[\[(]([^\][()]*)[\])]/g, (whole, inner) => {
    const t = inner.trim();
    if (VERSION_WORDS.test(t)) return `(${t})`;
    if (NOISE_SEGMENT.test(t)) return ' ';
    return whole;
  }).replace(/\s+/g, ' ').trim();
}

function normalizeFeat(s) {
  return String(s || '').replace(/\b(?:featuring|ft\.?|feat\.?)\s+/gi, 'feat. ');
}

function cleanUploader(u) {
  return String(u || '')
    .replace(/\s*-\s*topic$/i, '')
    .replace(/vevo$/i, '')
    .replace(/\s*(official|music|tv|records|recordings|channel)\s*$/i, '')
    .trim();
}

// Split a raw source title into { artist, title }. The uploader is the
// fallback artist when there's no "Artist - Title" separator.
function parseSource(rawTitle, uploader) {
  let t = stripNoise(normalizeFeat(rawTitle));
  t = t.replace(/^\s*\d{1,2}[.)]\s+/, ''); // leading track numbers: "01. ..."
  const m = t.split(/\s+[-–—]\s+/);
  let artist, title;
  if (m.length >= 2) {
    artist = m[0].trim();
    title = m.slice(1).join(' - ').trim();
  } else {
    artist = cleanUploader(uploader);
    title = t.trim();
  }
  // '"Title" by Artist' shape
  if (!artist && /\bby\b/i.test(title)) {
    const bym = title.match(/^(.*)\s+by\s+(.+)$/i);
    if (bym) { title = bym[1].trim(); artist = bym[2].trim(); }
  }
  return { artist: artist || '', title: title || t };
}

// ---------- scoring ----------

function versionKey(s) {
  const found = new Set();
  // "Original Mix" / "Original Version" is how dance releases label the
  // *unmodified* track. It marks the absence of a version, so it must not
  // read as a remix — otherwise the correct upload scores like a wrong one.
  const cleaned = normalize(s).replace(/\boriginal(\s+(mix|version|cut|edit))?\b/g, ' ');
  const re = new RegExp(VERSION_WORDS.source, 'gi');
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    let w = m[1].toLowerCase().replace(/^re-?edit$/, 'edit').replace(/^remastered$/, 'remaster');
    if (w === 'mix' || w === 'version' || w === 'refix' || w === 'flip' || w === 'rework') w = 'remix';
    found.add(w);
  }
  found.delete('remaster'); // remasters are the same recording — not a version mismatch
  return [...found].sort().join('+');
}

function titleScore(sourceTitle, candidateName) {
  let s = tokenSetRatio(sourceTitle, candidateName);
  // Penalise hard if remix/version markers differ.
  if (versionKey(sourceTitle) !== versionKey(candidateName)) s *= 0.25;
  return s;
}

// Check against all listed artists, not just the first.
function artistScore(sourceArtist, candidateArtists) {
  if (!sourceArtist) return 0.5; // unknown source artist: neutral, not zero
  const names = (candidateArtists || []).map((a) => a.name);
  let best = tokenSetRatio(sourceArtist, names.join(' '));
  for (const n of names) best = Math.max(best, tokenSetRatio(sourceArtist, n));
  return best;
}

// ≤3s apart scores full; degrades linearly to 0 at 20s apart. Duration is
// independent of spelling — the strongest guard against plausible-but-wrong.
function durationScore(aSec, bSec) {
  if (aSec == null || bSec == null) return null;
  const d = Math.abs(aSec - bSec);
  if (d <= 3) return 1;
  if (d >= 20) return 0;
  return 1 - (d - 3) / 17;
}

function scoreCandidate(parsed, sourceDurationSec, track) {
  const t = titleScore(parsed.title, track.name);
  const a = artistScore(parsed.artist, track.artists);
  const d = durationScore(sourceDurationSec, track.duration_ms != null ? track.duration_ms / 1000 : null);
  if (d === null) {
    // No duration available — reweight rather than fake a signal.
    return 0.6 * t + 0.4 * a;
  }
  return 0.45 * t + 0.3 * a + 0.25 * d;
}

// ---------- release selection ----------

function albumTypeRank(type) {
  if (type === 'album' || type === 'single') return 0;
  if (type === 'compilation') return 2;
  return 1;
}

function dateKey(releaseDate) {
  const d = String(releaseDate || '9999');
  if (d.length === 4) return `${d}-12-31`;
  if (d.length === 7) return `${d}-28`;
  return d;
}

// Among candidates that are plausibly the same recording, prefer
// album/single over compilation, then the earliest release.
function pickRelease(scored, best) {
  const same = scored.filter((c) =>
    c.score >= best.score - 0.03 &&
    tokenSetRatio(c.track.name, best.track.name) > 0.85 &&
    Math.abs((c.track.duration_ms || 0) - (best.track.duration_ms || 0)) <= 3000
  );
  same.sort((x, y) => {
    const tr = albumTypeRank(x.track.album?.album_type) - albumTypeRank(y.track.album?.album_type);
    if (tr) return tr;
    return dateKey(x.track.album?.release_date).localeCompare(dateKey(y.track.album?.release_date));
  });
  return same[0] || best;
}

// ---------- meta extraction ----------

function pickImage(images, wantSize) {
  const want = parseInt(wantSize, 10) || 640;
  if (!images || !images.length) return null;
  const sorted = [...images].sort((a, b) => (a.width || 0) - (b.width || 0));
  for (const img of sorted) if ((img.width || 0) >= want) return img;
  return sorted[sorted.length - 1];
}

function metaFromTrack(track, artSize) {
  const al = track.album || {};
  const img = pickImage(al.images, artSize);
  return {
    spotifyId: track.id || null,
    title: track.name || '',
    artist: (track.artists || []).map((a) => a.name).join(', '),
    artistIds: (track.artists || []).map((a) => a.id).filter(Boolean),
    albumArtist: (al.artists && al.artists[0] && al.artists[0].name) || (track.artists && track.artists[0] && track.artists[0].name) || '',
    album: al.name || '',
    albumId: al.id || null,
    albumType: al.album_type || null,
    trackNo: track.track_number || null,
    trackTotal: al.total_tracks || null,
    discNo: track.disc_number || null,
    year: String(al.release_date || '').slice(0, 4) || null,
    releaseDate: al.release_date || null,
    isrc: (track.external_ids && track.external_ids.isrc) || null,
    durationMs: track.duration_ms || null,
    artUrl: img ? img.url : null,
  };
}

// ---------- top-level match ----------

// Try field-scoped, then freeform, then title-only. Stop at the first query
// whose best candidate clears the threshold.
async function match({ title, artist, durationSec }, { spotify, threshold, artSize }) {
  const queries = [];
  if (artist) queries.push(`track:"${title}" artist:"${artist}"`);
  if (artist) queries.push(`${artist} ${title}`);
  queries.push(`"${title}"`);

  const parsed = { title, artist };
  let overallBest = null;

  for (const q of queries) {
    let items;
    try {
      items = await spotify.searchTracks(q, 10);
    } catch (err) {
      if (err.kind === 'ratelimit' || err.kind === 'auth') throw err;
      continue; // one query shape failing is not fatal — try the next
    }
    if (!items || !items.length) continue;

    const scored = items
      .filter((t) => t && t.id)
      .map((track) => ({ track, score: scoreCandidate(parsed, durationSec, track) }));
    if (!scored.length) continue;

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!overallBest || best.score > overallBest.score) overallBest = best;

    if (best.score >= threshold) {
      const chosen = pickRelease(scored, best);
      return { matched: true, score: best.score, meta: metaFromTrack(chosen.track, artSize) };
    }
  }

  return { matched: false, score: overallBest ? overallBest.score : 0, meta: null };
}

module.exports = {
  normalize, tokens, tokenSetRatio, parseSource, stripNoise, cleanUploader,
  scoreCandidate, durationScore, versionKey, pickRelease, metaFromTrack, pickImage, match,
};
