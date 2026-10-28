// Fetches the official standalone yt-dlp binary into bin/ so no Python
// install is needed. Runs on npm install; skips if the binary already exists.
// Source: the yt-dlp project's own GitHub releases.
'use strict';

const fs = require('fs');
const path = require('path');

const NAMES = {
  win32: 'yt-dlp.exe',
  darwin: 'yt-dlp_macos',
  linux: 'yt-dlp',
};

async function main() {
  const asset = NAMES[process.platform] || 'yt-dlp';
  const localName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const binDir = path.join(__dirname, '..', 'bin');
  const dest = path.join(binDir, localName);

  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`yt-dlp already present at ${dest}`);
    return;
  }

  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  console.log(`Downloading yt-dlp from ${url} ...`);

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error(`Downloaded file suspiciously small (${buf.length} bytes)`);

  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(dest, buf);
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  console.log(`yt-dlp saved to ${dest} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

main().catch((err) => {
  // Not fatal for install — the app also offers an in-app download in
  // Settings → Tools, and respects a custom ytdlpPath setting.
  console.warn(`Could not fetch yt-dlp automatically: ${err.message}`);
  console.warn('You can download it later from Settings → Tools inside the app.');
});
