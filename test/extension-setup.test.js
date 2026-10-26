'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detect, browserIdForProgId } = require('../src/browsers');
const { ExtensionSetup, deployExtension } = require('../src/extension-setup');

const SRC = path.join(__dirname, '..', 'extension');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ext-setup-test-'));
const TOKEN = 'a'.repeat(32);

test('tarayıcı tespiti: yalnızca var olan exe, tanımsız ortam değişkeni atlanır', () => {
  const env = { ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\U\\L' }; // ProgramFiles(x86) yok
  const present = new Set([
    'C:\\PF\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\U\\L\\Programs\\Opera GX\\opera.exe',
  ]);
  const found = detect({ env, exists: (p) => present.has(p) });
  assert.deepEqual(found.map((b) => [b.id, b.exe, b.page]), [
    ['chrome', 'C:\\PF\\Google\\Chrome\\Application\\chrome.exe', 'chrome://extensions'],
    ['operagx', 'C:\\U\\L\\Programs\\Opera GX\\opera.exe', 'opera://extensions'],
  ]);
});

test('varsayılan tarayıcı ProgId eşlemesi', () => {
  assert.equal(browserIdForProgId('ChromeHTML'), 'chrome');
  assert.equal(browserIdForProgId('MSEdgeHTM'), 'edge');
  assert.equal(browserIdForProgId('BraveHTML'), 'brave');
  assert.equal(browserIdForProgId('VivaldiHTM.ABC123'), 'vivaldi');
  assert.equal(browserIdForProgId('OperaGXStable'), 'operagx');
  assert.equal(browserIdForProgId('FirefoxURL-308046B0AF4A39CB'), null);
  assert.equal(browserIdForProgId(undefined), null);
});

test('deployExtension: dosyaları kopyalar, bootstrap.json yazar, tekrarında token güncellenir', () => {
  const dir = path.join(tmp(), 'extension');
  const version = deployExtension(SRC, dir, { port: 17865, token: TOKEN });
  assert.equal(version, JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8')).version);
  for (const f of ['manifest.json', 'background.js', 'popup.html', 'icons/128.png']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'bootstrap.json'), 'utf8')), { port: 17865, token: TOKEN });

  deployExtension(SRC, dir, { port: 18000, token: 'b'.repeat(32) });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'bootstrap.json'), 'utf8')), { port: 18000, token: 'b'.repeat(32) });
  assert.ok(!fs.existsSync(path.join(SRC, 'bootstrap.json')), 'kaynak klasöre yazılmamalı');
});

function fakeBrowsers(opened) {
  const list = [{ id: 'edge', name: 'Microsoft Edge', page: 'edge://extensions', exe: 'C:\\x\\msedge.exe' }];
  return {
    detect: () => list,
    defaultBrowserId: async () => 'edge',
    openExtensionsPage: async (b) => { opened.push(b.id); },
  };
}

test('ExtensionSetup: ilk açılış → kur → bağlandı; durum kalıcı', async () => {
  const userData = tmp();
  const opened = [];
  let info = { port: 17865, token: TOKEN };
  const mk = () => new ExtensionSetup({ srcDir: SRC, userData, bridgeInfo: () => info, browserApi: fakeBrowsers(opened) });

  const s = mk();
  assert.equal(s.needsSetup, true);
  assert.equal(s.refresh(), false, 'kurulmadan refresh bir şey yapmaz');
  const st = await s.status();
  assert.equal(st.defaultId, 'edge');
  assert.equal(st.browsers.length, 1);

  await assert.rejects(s.install('chrome'), /bulunamadı/);
  const r = await s.install('edge');
  assert.deepEqual(opened, ['edge']);
  assert.equal(r.dir, path.join(userData, 'extension'));
  assert.ok(fs.existsSync(path.join(r.dir, 'bootstrap.json')));
  assert.equal(s.needsSetup, true, 'eklenti bağlanana kadar kurulum tamamlanmış sayılmaz');

  // Token yenilenince refresh bootstrap.json'u günceller
  info = { port: 17865, token: 'c'.repeat(32) };
  assert.equal(s.refresh(), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir, 'bootstrap.json'), 'utf8')).token, 'c'.repeat(32));

  s.markConnected('extension/1.0.0');
  assert.equal(s.needsSetup, false);
  const again = mk();
  assert.equal(again.needsSetup, false);
  assert.equal(again.state.browser, 'edge');
  assert.equal(again.state.client, 'extension/1.0.0');
});

test('ExtensionSetup: "daha sonra" kalıcı', () => {
  const userData = tmp();
  const mk = () => new ExtensionSetup({ srcDir: SRC, userData, bridgeInfo: () => ({}), browserApi: fakeBrowsers([]) });
  mk().skip();
  assert.equal(mk().needsSetup, false);
});
