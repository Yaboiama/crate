// Puts a Crate shortcut on the desktop, so the app can be opened without a
// terminal.  Run it with:  npm run shortcut
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function desktopDir() {
  const guess = path.join(os.homedir(), 'Desktop');
  if (fs.existsSync(guess)) return guess;
  // OneDrive-redirected desktops are common on Windows
  const oneDrive = process.env.OneDrive && path.join(process.env.OneDrive, 'Desktop');
  if (oneDrive && fs.existsSync(oneDrive)) return oneDrive;
  return null;
}

function electronBinary() {
  const rel = process.platform === 'win32'
    ? path.join('node_modules', 'electron', 'dist', 'electron.exe')
    : path.join('node_modules', '.bin', 'electron');
  const full = path.join(ROOT, rel);
  return fs.existsSync(full) ? full : null;
}

function main() {
  const desktop = desktopDir();
  if (!desktop) {
    console.error("Couldn't find your Desktop folder — make the shortcut by hand.");
    process.exit(1);
  }
  const electron = electronBinary();
  if (!electron) {
    console.error('Electron is not installed yet. Run "npm install" first.');
    process.exit(1);
  }

  if (process.platform === 'win32') {
    const lnk = path.join(desktop, 'Crate.lnk');
    // Build the .lnk through the Windows shell, the only reliable way.
    const ps = [
      '$ws = New-Object -ComObject WScript.Shell;',
      `$s = $ws.CreateShortcut(${JSON.stringify(lnk)});`,
      `$s.TargetPath = ${JSON.stringify(electron)};`,
      "$s.Arguments = '.';",
      `$s.WorkingDirectory = ${JSON.stringify(ROOT)};`,
      "$s.Description = 'Crate - music downloader';",
      '$s.Save();',
    ].join(' ');
    // "powershell" is not always resolvable by name (Git Bash, trimmed PATH),
    // so fall back to where Windows actually keeps it.
    const candidates = [
      'powershell.exe',
      path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      'pwsh.exe',
    ];
    let made = false;
    let lastErr = null;
    for (const exe of candidates) {
      try {
        execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
        made = true;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!made) throw lastErr || new Error('PowerShell not found');
    console.log(`Shortcut created: ${lnk}`);
    return;
  }

  if (process.platform === 'darwin') {
    const cmd = path.join(desktop, 'Crate.command');
    fs.writeFileSync(cmd, `#!/bin/sh\ncd ${JSON.stringify(ROOT)}\nexec npm start\n`);
    fs.chmodSync(cmd, 0o755);
    console.log(`Shortcut created: ${cmd}`);
    return;
  }

  const entry = path.join(desktop, 'crate.desktop');
  fs.writeFileSync(entry, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Crate',
    'Comment=Music downloader',
    `Exec=${electron} .`,
    `Path=${ROOT}`,
    'Terminal=false',
    '',
  ].join('\n'));
  fs.chmodSync(entry, 0o755);
  console.log(`Shortcut created: ${entry}`);
}

try {
  main();
} catch (err) {
  console.error(`Couldn't create the shortcut: ${err.message}`);
  process.exit(1);
}
