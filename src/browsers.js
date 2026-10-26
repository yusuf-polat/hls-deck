'use strict';
// Eklentinin kurulabileceği Chromium tabanlı tarayıcıları (Windows) bulur ve eklenti sayfalarını açar.
// Firefox listede yok: eklenti MV3 service worker ve webRequest 'extraHeaders' kullanıyor.
const fs = require('node:fs');
const { execFile, spawn } = require('node:child_process');

const BROWSERS = [
  {
    id: 'chrome', name: 'Google Chrome', page: 'chrome://extensions', progId: /^ChromeHTML$/i,
    exe: ['%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe', '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe',
      '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe'],
  },
  {
    id: 'edge', name: 'Microsoft Edge', page: 'edge://extensions', progId: /^MSEdgeHTM$/i,
    exe: ['%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe', '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe'],
  },
  {
    id: 'brave', name: 'Brave', page: 'brave://extensions', progId: /^BraveHTML$/i,
    exe: ['%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', '%ProgramFiles(x86)%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  },
  {
    id: 'opera', name: 'Opera', page: 'opera://extensions', progId: /^OperaStable$/i,
    exe: ['%LOCALAPPDATA%\\Programs\\Opera\\opera.exe', '%ProgramFiles%\\Opera\\opera.exe'],
  },
  {
    id: 'operagx', name: 'Opera GX', page: 'opera://extensions', progId: /^OperaGXStable$/i,
    exe: ['%LOCALAPPDATA%\\Programs\\Opera GX\\opera.exe'],
  },
  {
    id: 'vivaldi', name: 'Vivaldi', page: 'vivaldi://extensions', progId: /^VivaldiHTM/i,
    exe: ['%LOCALAPPDATA%\\Vivaldi\\Application\\vivaldi.exe', '%ProgramFiles%\\Vivaldi\\Application\\vivaldi.exe'],
  },
  {
    id: 'chromium', name: 'Chromium', page: 'chrome://extensions', progId: /^ChromiumHTM/i,
    exe: ['%LOCALAPPDATA%\\Chromium\\Application\\chrome.exe'],
  },
];

/** %VAR% kalıplarını açar; tanımsız değişken içeren yol null döner. */
function expand(p, env) {
  let missing = false;
  const out = p.replace(/%([^%]+)%/g, (_m, k) => {
    const v = env[k];
    if (!v) missing = true;
    return v || '';
  });
  return missing ? null : out;
}

/** Kurulu tarayıcılar: [{ id, name, page, exe }] */
function detect({ env = process.env, exists = fs.existsSync } = {}) {
  const found = [];
  for (const b of BROWSERS) {
    const exe = b.exe.map((p) => expand(p, env)).find((p) => p && exists(p));
    if (exe) found.push({ id: b.id, name: b.name, page: b.page, exe });
  }
  return found;
}

function browserIdForProgId(progId) {
  return BROWSERS.find((b) => b.progId.test(progId || ''))?.id || null;
}

/** Windows'ta https için seçili varsayılan tarayıcı (bilinmiyorsa null). */
function defaultBrowserId() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const key = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', 'ProgId'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(browserIdForProgId(/ProgId\s+REG_SZ\s+(\S+)/i.exec(stdout)?.[1]));
    });
  });
}

/** Tarayıcıyı eklenti sayfasıyla açar (açıksa mevcut pencerede yeni sekme olarak). */
function openExtensionsPage(browser) {
  return new Promise((resolve, reject) => {
    const p = spawn(browser.exe, [browser.page], { detached: true, stdio: 'ignore' });
    p.once('error', reject);
    p.once('spawn', () => { p.unref(); resolve(); });
  });
}

module.exports = { BROWSERS, detect, browserIdForProgId, defaultBrowserId, openExtensionsPage };
