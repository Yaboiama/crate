// Repairs mislabelled cover art in existing MP3s.
//
// Some players (Traktor among them) trust the MIME type declared in the APIC
// frame. A WebP thumbnail labelled "image/jpeg" is rejected outright as an
// unsupported cover art file type. This converts the picture to a real JPEG.
//
// It edits the APIC frame only: every other frame — including the large PRIV
// blocks Traktor writes for beatgrids and cues — is copied byte for byte, and
// the audio is verified identical before the file is replaced.
//
//   node scripts/fix-cover-art.js "D:/path/to/music"           # report only
//   node scripts/fix-cover-art.js "D:/path/to/music" --write    # repair
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const root = process.argv[2];
const WRITE = process.argv.includes('--write');
if (!root) {
  console.error('usage: node scripts/fix-cover-art.js <folder> [--write]');
  process.exit(2);
}
const ffmpeg = require('ffmpeg-static');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-art-'));

function sniff(b) {
  if (!b || b.length < 12) return 'empty';
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (b.slice(0, 3).toString('latin1') === 'GIF') return 'gif';
  return 'unknown';
}

const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
function putSyncsafe(b, o, v) {
  b[o] = (v >> 21) & 0x7f; b[o + 1] = (v >> 14) & 0x7f; b[o + 2] = (v >> 7) & 0x7f; b[o + 3] = v & 0x7f;
}

// Split the tag into raw frame buffers, so untouched frames can be re-emitted
// exactly as they were found.
function parseTag(buf) {
  if (buf.slice(0, 3).toString('latin1') !== 'ID3') return { skip: 'no ID3v2 tag' };
  const ver = buf[3];
  if (ver !== 3 && ver !== 4) return { skip: 'unsupported ID3 version' };
  const flags = buf[5];
  if (flags & 0x80) return { skip: 'tag uses unsynchronisation' };
  if (flags & 0x40) return { skip: 'tag has an extended header' };
  const tagSize = syncsafe(buf, 6);
  const audioStart = 10 + tagSize;
  if (audioStart > buf.length) return { skip: 'truncated tag' };

  const frames = [];
  let i = 10;
  while (i + 10 <= audioStart) {
    const id = buf.slice(i, i + 4).toString('latin1');
    if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding begins
    const size = ver === 4 ? syncsafe(buf, i + 4) : buf.readUInt32BE(i + 4);
    if (size <= 0 || i + 10 + size > audioStart) return { skip: 'malformed frame table' };
    frames.push({ id, flags: buf.slice(i + 8, i + 10), body: buf.slice(i + 10, i + 10 + size) });
    i += 10 + size;
  }
  return { ver, frames, audioStart };
}

// APIC body: encoding, MIME (latin1, NUL), picture type, description, image.
function parseApic(body) {
  const enc = body[0];
  let p = 1;
  while (p < body.length && body[p] !== 0x00) p++;
  const mime = body.slice(1, p).toString('latin1');
  p += 1;
  const picType = body[p]; p += 1;
  const descStart = p;
  if (enc === 1 || enc === 2) {
    while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < body.length && body[p] !== 0x00) p++;
    p += 1;
  }
  if (p > body.length) return null;
  return { enc, mime, picType, desc: body.slice(descStart, p), image: body.slice(p) };
}

function buildApic(a, jpegBuf) {
  return Buffer.concat([
    Buffer.from([a.enc]),
    Buffer.from('image/jpeg', 'latin1'), Buffer.from([0x00]),
    Buffer.from([a.picType]),
    a.desc,
    jpegBuf,
  ]);
}

function toJpeg(buf, ext) {
  const inP = path.join(TMP, 'in.' + ext);
  const outP = path.join(TMP, 'out.jpg');
  fs.writeFileSync(inP, buf);
  try { fs.unlinkSync(outP); } catch { /* first run */ }
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', inP, '-q:v', '2', outP], { timeout: 60000 });
  const out = fs.readFileSync(outP);
  if (sniff(out) !== 'jpeg') throw new Error('conversion did not produce a JPEG');
  return out;
}

function walk(d, out) {
  let ents = [];
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.toLowerCase().endsWith('.mp3')) out.push(p);
  }
  return out;
}

// Scanning reads only the ID3 tag, not the whole file — a library of
// thousands of tracks is tens of gigabytes and does not need to be read.
function readTagOnly(p) {
  let fd;
  try { fd = fs.openSync(p, 'r'); } catch { return null; }
  try {
    const head = Buffer.alloc(10);
    if (fs.readSync(fd, head, 0, 10, 0) < 10) return null;
    if (head.slice(0, 3).toString('latin1') !== 'ID3') return null;
    const size = syncsafe(head, 6);
    if (size <= 0 || size > 64 * 1024 * 1024) return null;
    const buf = Buffer.alloc(10 + size);
    head.copy(buf, 0);
    fs.readSync(fd, buf, 10, size, 10);
    return buf;
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

const files = walk(root, []);
let scanned = 0; let broken = 0; let fixed = 0; let failed = 0;

for (const p of files) {
  scanned++;
  if (scanned % 250 === 0) console.log('  ...' + scanned + ' scanned');
  const tagBuf = readTagOnly(p);
  if (!tagBuf) continue;
  const tag = parseTag(tagBuf);
  if (tag.skip) continue;
  if (!tag.frames.some((f) => f.id === 'APIC')) continue;
  let buf = tagBuf; // full file is only read when a repair is actually needed

  let dirty = false;
  const rebuilt = [];
  for (const f of tag.frames) {
    // leave compressed/encrypted frames alone — we can't safely rewrite them
    const awkward = f.flags[1] & (tag.ver === 4 ? 0x0F : 0xE0);
    if (f.id !== 'APIC' || awkward) { rebuilt.push(f); continue; }
    const a = parseApic(f.body);
    if (!a) { rebuilt.push(f); continue; }
    const kind = sniff(a.image);
    if (kind === 'jpeg' || (kind === 'png' && /png/i.test(a.mime))) { rebuilt.push(f); continue; }
    broken++;
    console.log('  ' + path.basename(p));
    console.log('     declared ' + a.mime + ', actually ' + kind + ' (' + (a.image.length / 1024).toFixed(0) + 'KB)');
    if (!WRITE) { rebuilt.push(f); continue; }
    try {
      const jpeg = toJpeg(a.image, kind === 'unknown' ? 'bin' : kind);
      rebuilt.push({ id: 'APIC', flags: f.flags, body: buildApic(a, jpeg) });
      dirty = true;
    } catch (err) {
      failed++;
      console.log('     -> conversion failed: ' + err.message);
      rebuilt.push(f);
    }
  }
  if (!dirty) continue;

  try { buf = fs.readFileSync(p); } catch { failed++; continue; }
  const full = parseTag(buf);
  if (full.skip || full.frames.length !== tag.frames.length) { failed++; continue; }
  tag.audioStart = full.audioStart;

  const parts = [];
  for (const f of rebuilt) {
    const head = Buffer.alloc(10);
    head.write(f.id, 0, 4, 'latin1');
    if (tag.ver === 4) putSyncsafe(head, 4, f.body.length);
    else head.writeUInt32BE(f.body.length, 4);
    f.flags.copy(head, 8);
    parts.push(head, f.body);
  }
  const body = Buffer.concat(parts);
  const padding = Buffer.alloc(512, 0);
  const header = Buffer.from(buf.slice(0, 10));
  putSyncsafe(header, 6, body.length + padding.length);
  const audio = buf.slice(tag.audioStart);
  const out = Buffer.concat([header, body, padding, audio]);

  // Verify before replacing: same frames in order, audio byte-identical,
  // and the artwork now genuinely a JPEG.
  const check = parseTag(out);
  const okFrames = !check.skip
    && check.frames.length === rebuilt.length
    && check.frames.every((f, i) => f.id === rebuilt[i].id)
    && out.slice(check.audioStart).equals(audio);
  const apic = check.skip ? null : check.frames.find((f) => f.id === 'APIC');
  const okArt = apic && sniff(parseApic(apic.body).image) === 'jpeg';
  if (!okFrames || !okArt) {
    failed++;
    console.log('     -> verification failed, left untouched');
    continue;
  }

  const tmp = p + '.crate-tmp';
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, p);
  fixed++;
  console.log('     -> converted to real JPEG; audio and all other tags preserved');
}

console.log('\nscanned ' + scanned + ' files · ' + broken + ' with unusable cover art · ' + fixed + ' repaired · ' + failed + ' failed');
if (!WRITE && broken) console.log('This was a dry run. Re-run with --write to repair.');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
