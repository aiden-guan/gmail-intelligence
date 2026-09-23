#!/usr/bin/env node
/**
 * Reveal the built extension and open the browser's extensions page.
 *   npm run open
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'apps', 'extension', 'dist');

if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('The extension is not built yet. Run: npm run setup');
  process.exit(1);
}

function copyToClipboard(text) {
  if (process.platform === 'darwin') {
    return spawnSync('pbcopy', { input: text }).status === 0;
  }
  if (process.platform === 'win32') {
    return spawnSync('clip', { input: text, shell: true }).status === 0;
  }
  if (spawnSync('wl-copy', { input: text }).status === 0) return true;
  return spawnSync('xclip', ['-selection', 'clipboard'], { input: text }).status === 0;
}

const copied = copyToClipboard(dist);

function localChrome() {
  const path = join(root, '.local', 'chrome.json');
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const chromeConfig = localChrome();
const gmailUrl = chromeConfig.gmailAccount
  ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(chromeConfig.gmailAccount)}#inbox`
  : 'https://mail.google.com/';

function openMacChromeProfile() {
  const profile = chromeConfig.profileDirectory;
  if (!profile || process.platform !== 'darwin') return null;
  const bin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!existsSync(bin)) return null;
  const result = spawnSync(bin, [`--profile-directory=${profile}`, 'chrome://extensions/', gmailUrl], {
    stdio: 'ignore',
  });
  return result.status === 0 ? 'Google Chrome' : null;
}

function tryOpenMacBrowser() {
  const apps = ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser'];
  for (const app of apps) {
    const result = spawnSync(
      'osascript',
      [
        '-e',
        `tell application "${app}" to activate`,
        '-e',
        `tell application "${app}" to open location "chrome://extensions"`,
      ],
      { stdio: 'ignore' },
    );
    if (result.status === 0) return app;
  }
  return null;
}

function openFolder() {
  if (process.platform === 'darwin') {
    spawnSync('open', [dist], { stdio: 'inherit' });
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('explorer', [dist], { shell: true, stdio: 'inherit' });
    return;
  }
  spawnSync('xdg-open', [dist], { stdio: 'inherit' });
}

openFolder();

let browser = null;
if (process.platform === 'darwin') {
  browser = openMacChromeProfile() || tryOpenMacBrowser();
} else if (process.platform === 'win32') {
  const result = spawnSync('cmd', ['/c', 'start', 'chrome', 'chrome://extensions'], { stdio: 'ignore' });
  if (result.status === 0) browser = 'Chrome';
} else {
  for (const bin of ['google-chrome', 'chromium', 'microsoft-edge', 'brave-browser']) {
    const result = spawnSync(bin, ['chrome://extensions'], { stdio: 'ignore', detached: true });
    if (result.status === 0 || result.error == null) {
      browser = bin;
      break;
    }
  }
}

console.log(`Extension folder${copied ? ' (copied to the clipboard)' : ''}:`);
console.log(`  ${dist}`);
console.log('');
if (browser) {
  const who = chromeConfig.gmailAccount ? ` for ${chromeConfig.gmailAccount}` : '';
  const profile = chromeConfig.profileDirectory ? ` (${chromeConfig.profileDirectory})` : '';
  console.log(`Opened ${browser}${profile} to the extensions page${who}.`);
} else {
  console.log('Open chrome://extensions in Chrome, Edge, or Brave.');
}
console.log('Turn on Developer mode, click Load unpacked, and select that folder.');
console.log(`Then use ${gmailUrl}`);
