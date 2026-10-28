// External binaries: yt-dlp and ffmpeg. Resolution order is the settings
// path, then the bundled bin/ copy, then PATH. One yt-dlp invocation per
// track, each with its own timeout — a hung track can't take down the batch.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { CrateError } = require('./politeness');

const IS_WIN = process.platform === 'win32';
const YTDLP_NAME = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';

let S = null; // { settings, appRoot }
let ytdlpCache = null; // { path, version } | null
const activeChildren = new Set();

function init(ctx) {
  S = ctx;
  S.settings.onChange((_all, patch) => {
    if ('ytdlpPath' in patch) ytdlpCache = null;
  });
}

function killAll() {
  for (const child of activeChildren) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

// ---------- process running ----------

function run(bin, args, { timeoutMs = 120000, onStdoutLine, onStderrLine } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    const lineBuffer = (cb) => {
      let buf = '';
      return (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line && cb) cb(line);
        }
      };
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const outLine = lineBuffer(onStdoutLine);
    const errLine = lineBuffer(onStderrLine);
    child.stdout.on('data', (d) => { if (stdout.length < 30_000_000) stdout += d; outLine(d); });
    child.stderr.on('data', (d) => { if (stderr.length < 1_000_000) stderr += d; errLine(d); });

    child.on('error', (err) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message, timedOut, spawnError: err });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// ---------- yt-dlp ----------

async function probeVersion(bin) {
  const r = await run(bin, ['--version'], { timeoutMs: 15000 });
  if (r.code === 0 && /^\d{4}\.\d{2}\.\d{2}/.test(r.stdout.trim())) return r.stdout.trim();
  return null;
}

async function ytdlpInfo(force = false) {
  if (ytdlpCache && !force) return ytdlpCache;
  const s = S.settings.get();
  const candidates = [
    s.ytdlpPath && s.ytdlpPath.trim(),
    path.join(S.appRoot, 'bin', YTDLP_NAME),
    'yt-dlp',
  ].filter(Boolean);
  for (const cand of candidates) {
    if (cand.includes(path.sep) && !fs.existsSync(cand)) continue;
    const version = await probeVersion(cand);
    if (version) {
      ytdlpCache = { path: cand, version };
      return ytdlpCache;
    }
  }
  ytdlpCache = null;
  return null;
}

function classifyYtdlp(stderr, timedOut, timeoutMs) {
  const text = String(stderr || '');
  if (timedOut) {
    return new CrateError('transient', `Track took longer than ${Math.round(timeoutMs / 1000)}s and was stopped — will retry`);
  }
  if (/429|too many requests|rate.?limit/i.test(text)) {
    return new CrateError('ratelimit', 'Rate limited by the source');
  }
  // A 403 on the media URL itself means the extractor's signature handling is
  // out of date — retrying cannot fix it and only hammers the host.
  if (/unable to download video data.*403|http error 403|forbidden/i.test(text)) {
    return new CrateError('extractor', 'YouTube refused the download (403) — yt-dlp is out of date. Update it in Settings › Tools, then press Retry failed');
  }
  if (/private video|video unavailable|content isn.?t available|this video is not available|account.*terminated|removed|copyright|not available in your country|region|geo.?restrict|age.restrict|sign in to confirm|members.only|premieres in/i.test(text)) {
    const reason =
      /private/i.test(text) ? 'This video is private' :
      /age.restrict|sign in to confirm/i.test(text) ? 'Age-restricted — needs a signed-in session, which Crate deliberately does not use' :
      /country|region|geo/i.test(text) ? 'Not available in your region' :
      /copyright/i.test(text) ? 'Removed for copyright' :
      'This video is no longer available';
    return new CrateError('permanent', reason);
  }
  if (/unsupported url|unable to extract|no video formats found|is not a valid url/i.test(text)) {
    return new CrateError('extractor', "yt-dlp couldn't read this page — it may need an update (Settings › Tools)");
  }
  if (/timed? out|connection|network is unreachable|temporary failure|getaddrinfo|name resolution|reset by peer|refused|unexpected eof|ssl/i.test(text)) {
    return new CrateError('transient', 'Network problem talking to the source — will retry');
  }
  const lastErr = (text.match(/ERROR:?\s*(.+)/g) || []).pop();
  return new CrateError('transient', lastErr ? lastErr.slice(0, 200) : 'Download failed — will retry');
}

async function runYtdlp(args, { timeoutMs = 120000, onProgress } = {}) {
  const info = await ytdlpInfo();
  if (!info) {
    throw new CrateError('tooling', 'yt-dlp is not installed — download it from Settings › Tools');
  }
  const r = await run(info.path, args, {
    timeoutMs,
    onStdoutLine: (line) => {
      if (onProgress && line.startsWith('dl:')) {
        try {
          const p = JSON.parse(line.slice(3));
          const total = p.total_bytes || p.total_bytes_estimate;
          if (total && p.downloaded_bytes != null) onProgress(Math.min(1, p.downloaded_bytes / total));
        } catch { /* partial progress line */ }
      }
    },
  });
  if (r.spawnError) throw new CrateError('tooling', `Couldn't start yt-dlp: ${r.spawnError.message}`);
  if (r.code !== 0) throw classifyYtdlp(r.stderr, r.timedOut, timeoutMs);
  return r;
}

async function runYtdlpJson(args, opts = {}) {
  const r = await runYtdlp(args, opts);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new CrateError('extractor', "yt-dlp returned unreadable data — it may need an update (Settings › Tools)");
  }
}

// ---------- yt-dlp maintenance ----------

async function latestYtdlpVersion() {
  try {
    const res = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return (j.tag_name || '').replace(/^v/, '') || null;
  } catch {
    return null;
  }
}

async function updateYtdlp() {
  const info = await ytdlpInfo();
  if (!info) throw new CrateError('tooling', 'yt-dlp is not installed');
  const r = await run(info.path, ['-U'], { timeoutMs: 180000 });
  ytdlpCache = null;
  const fresh = await ytdlpInfo(true);
  return { output: (r.stdout + r.stderr).trim().split('\n').pop() || '', version: fresh && fresh.version };
}

async function downloadYtdlp() {
  const asset = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp' }[process.platform] || 'yt-dlp';
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new CrateError('transient', `Download failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) throw new CrateError('transient', 'Downloaded file looks incomplete — try again');
  const dest = path.join(S.appRoot, 'bin', YTDLP_NAME);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  if (!IS_WIN) fs.chmodSync(dest, 0o755);
  ytdlpCache = null;
  return ytdlpInfo(true);
}

// ---------- python / spotdl (optional helper) ----------
//
// Spotify refuses playlist listings to developer apps registered after its
// late-2024 change. If the user happens to have spotdl installed, its older
// registration can read a playlist of any length, so Crate will use it when
// it is there and working. Entirely optional — nothing breaks without it.

let pythonCache;

async function pythonPath() {
  if (pythonCache !== undefined) return pythonCache;
  const candidates = [];
  const s = S.settings.get();
  if (s.pythonPath && s.pythonPath.trim()) candidates.push(s.pythonPath.trim());
  // spotdl.exe lives in <python>/Scripts, so its sibling python is the one
  // that actually has the spotdl package importable
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const exe = path.join(dir, IS_WIN ? 'spotdl.exe' : 'spotdl');
    if (fs.existsSync(exe)) {
      candidates.push(path.join(path.dirname(exe), '..', IS_WIN ? 'python.exe' : 'bin/python3'));
    }
  }
  if (IS_WIN) {
    const base = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python');
    try {
      for (const d of fs.readdirSync(base)) candidates.push(path.join(base, d, 'python.exe'));
    } catch { /* no per-user python */ }
  }
  candidates.push(IS_WIN ? 'python.exe' : 'python3', 'python');

  for (const cand of candidates) {
    if (cand.includes(path.sep) && !fs.existsSync(cand)) continue;
    const r = await run(cand, ['-c', 'import spotdl, sys; sys.stdout.write("yes")'], { timeoutMs: 30000 });
    if (r.code === 0 && r.stdout.includes('yes')) { pythonCache = cand; return pythonCache; }
  }
  pythonCache = null;
  return null;
}

// spotdl's shared Spotify registration is heavily over-used and, when it is
// throttled, spotipy sleeps for the whole Retry-After rather than failing.
// So the probe is short and a failure is remembered, to keep a dud route
// from stalling every paste.
let spotdlBlockedUntil = 0;
const SPOTDL_PROBE_MS = 25000;
const SPOTDL_COOLOFF_MS = 6 * 60 * 60 * 1000;

// -> { ok, name, total, tracks } | { ok:false, error, retry }
async function spotdlList(url) {
  if (Date.now() < spotdlBlockedUntil) {
    return { ok: false, error: 'spotdl was unavailable recently; not retrying yet', retry: true };
  }
  const py = await pythonPath();
  if (!py) return { ok: false, error: 'spotdl is not installed' };
  const script = path.join(S.appRoot, 'scripts', 'spotdl-list.py');
  if (!fs.existsSync(script)) return { ok: false, error: 'helper script missing' };
  const r = await run(py, [script, url], { timeoutMs: SPOTDL_PROBE_MS });
  if (r.timedOut) {
    spotdlBlockedUntil = Date.now() + SPOTDL_COOLOFF_MS;
    return { ok: false, error: 'spotdl did not answer in time', retry: true };
  }
  const out = r.stdout.trim();
  if (!out) {
    const rateLimited = /rate\/request limit|429/i.test(r.stderr);
    const why = rateLimited
      ? "spotdl's shared Spotify access is rate limited"
      : (r.stderr.trim().split(String.fromCharCode(10)).pop() || 'no output');
    if (rateLimited) spotdlBlockedUntil = Date.now() + SPOTDL_COOLOFF_MS;
    return { ok: false, error: why, retry: rateLimited };
  }
  try {
    return JSON.parse(out.slice(out.indexOf('{')));
  } catch {
    return { ok: false, error: 'could not read spotdl output' };
  }
}

// ---------- ffmpeg ----------

function ffmpegPath() {
  const s = S.settings.get();
  if (s.ffmpegPath && s.ffmpegPath.trim()) return s.ffmpegPath.trim();
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch { /* not installed */ }
  return 'ffmpeg';
}

const BITRATE_ARGS = {
  '320': ['-b:a', '320k'],
  '256': ['-b:a', '256k'],
  '192': ['-b:a', '192k'],
  V0: ['-q:a', '0'],
};

async function convertToMp3(inPath, outPath, { bitrate = '320', timeoutMs = 600000 } = {}) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', inPath, '-vn',
    '-c:a', 'libmp3lame', ...(BITRATE_ARGS[bitrate] || BITRATE_ARGS['320']), outPath];
  const r = await run(ffmpegPath(), args, { timeoutMs });
  if (r.spawnError) throw new CrateError('tooling', `Couldn't start ffmpeg: ${r.spawnError.message}`);
  if (r.timedOut) throw new CrateError('transient', 'Conversion timed out — will retry');
  if (r.code !== 0) throw new CrateError('transient', `Conversion failed: ${r.stderr.trim().split('\n').pop() || 'unknown ffmpeg error'}`);
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    throw new CrateError('transient', 'Conversion produced an empty file — will retry');
  }
}

// EBU R128 loudness scan; ReplayGain 2 reference is -18 LUFS. Tags only —
// the audio itself is never altered.
async function measureGain(filePath) {
  const r = await run(ffmpegPath(), ['-hide_banner', '-i', filePath, '-map', 'a', '-af', 'ebur128', '-f', 'null', IS_WIN ? 'NUL' : '/dev/null'], { timeoutMs: 300000 });
  const matches = r.stderr.match(/I:\s*(-?[\d.]+)\s*LUFS/g);
  if (!matches || !matches.length) return null;
  const last = matches[matches.length - 1].match(/(-?[\d.]+)/);
  if (!last) return null;
  const integrated = parseFloat(last[1]);
  if (!Number.isFinite(integrated)) return null;
  return +(-18 - integrated).toFixed(2);
}

// Cover art must really be a JPEG, not merely labelled one. YouTube serves
// WebP thumbnails, and players that trust the declared MIME (Traktor among
// them) reject the file as an unsupported cover art type.
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'gif';
  return null;
}

// Re-encode any non-JPEG artwork through the bundled ffmpeg.
async function toJpeg(inPath, outPath) {
  const r = await run(ffmpegPath(), ['-y', '-hide_banner', '-loglevel', 'error', '-i', inPath, '-q:v', '2', outPath], { timeoutMs: 60000 });
  if (r.code !== 0 || !fs.existsSync(outPath) || fs.statSync(outPath).size === 0) return false;
  return true;
}

module.exports = {
  init, killAll, ytdlpInfo, runYtdlp, runYtdlpJson, classifyYtdlp, sniffImage, toJpeg,
  latestYtdlpVersion, updateYtdlp, downloadYtdlp, pythonPath, spotdlList,
  ffmpegPath, convertToMp3, measureGain,
};
