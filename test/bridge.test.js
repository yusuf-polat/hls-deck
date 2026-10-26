'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Bridge } = require('../src/bridge');

const PORT = 17999;
let bridge;
const imports = [];
const clients = [];

// fetch Host/Origin header'larını değiştirmeye izin vermediği için ham http istemcisi
function req(method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: pathname, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  bridge = new Bridge({
    file: path.join(dir, 'bridge.json'), port: PORT, version: '9.9.9',
    onImport: (p) => { imports.push(p); return { created: true, stream: { id: 'x1', name: p.pageTitle || 'adsız' } }; },
    onClient: (c) => clients.push(c),
  });
  bridge.start();
  await new Promise((r) => setTimeout(r, 100));
});
test.after(() => bridge.stop());

const auth = () => ({ 'x-m3u8-token': bridge.token });

test('token kalıcı ve 32 hex', () => {
  assert.match(bridge.token, /^[0-9a-f]{32}$/);
  const again = new Bridge({ file: bridge.file, port: 1, version: '', onImport() {} });
  assert.equal(again.token, bridge.token);
});

test('token olmadan / yanlış token ile 401', async () => {
  assert.equal((await req('GET', '/ping')).status, 401);
  assert.equal((await req('GET', '/ping', { headers: { 'x-m3u8-token': 'a'.repeat(32) } })).status, 401);
});

test('ping', async () => {
  const r = await req('GET', '/ping', { headers: auth() });
  assert.deepEqual(r, { status: 200, body: { ok: true, app: 'HLS Deck', version: '9.9.9' } });
});

test('web sayfası origin\'i ve yabancı Host reddedilir (CSRF / DNS rebinding)', async () => {
  assert.equal((await req('GET', '/ping', { headers: { ...auth(), origin: 'https://evil.com' } })).status, 403);
  assert.equal((await req('GET', '/ping', { headers: { ...auth(), host: 'evil.com:17999' } })).status, 403);
  assert.equal((await req('GET', '/ping', { headers: { ...auth(), origin: 'chrome-extension://abc' } })).status, 200);
});

test('x-m3u8-client yalnızca doğrulanmış istekte kaydedilir', async () => {
  const n = clients.length;
  await req('GET', '/ping', { headers: { 'x-m3u8-client': 'extension/0.0.1' } }); // token yok
  assert.equal(clients.length, n);
  await req('GET', '/ping', { headers: { ...auth(), 'x-m3u8-client': 'extension/1.2.3' } });
  assert.equal(clients.at(-1).name, 'extension/1.2.3');
  assert.equal(bridge.info().client.name, 'extension/1.2.3');
});

test('import doğrulama ve başarılı kayıt', async () => {
  const h = { ...auth(), 'content-type': 'application/json' };
  assert.equal((await req('POST', '/import', { headers: h, body: '{bozuk' })).status, 400);
  assert.equal((await req('POST', '/import', { headers: h, body: { url: 'file:///c:/x', headers: [] } })).status, 400);
  assert.equal((await req('POST', '/import', { headers: h, body: { url: 'https://a/x.m3u8', headers: [{ name: 1 }] } })).status, 400);

  const r = await req('POST', '/import', { headers: h, body: {
    url: 'https://a/x.m3u8', headers: [{ name: 'Referer', value: 'https://p/' }], pageTitle: 'Maç', pageUrl: 'https://p/mac', play: true, extra: 'yok sayılır',
  } });
  assert.deepEqual(r, { status: 200, body: { ok: true, created: true, stream: { id: 'x1', name: 'Maç' } } });
  assert.deepEqual(imports.at(-1), { url: 'https://a/x.m3u8', headers: [{ name: 'Referer', value: 'https://p/' }], pageUrl: 'https://p/mac', pageTitle: 'Maç', play: true });
});

test('gövde sınırı', async () => {
  const big = { url: 'https://a/x.m3u8', headers: [{ name: 'X', value: 'a'.repeat(300 * 1024) }] };
  const r = await req('POST', '/import', { headers: auth(), body: big }).catch((e) => ({ status: 'reset', e }));
  assert.ok(r.status === 400 || r.status === 'reset');
});

test('regenerate eski token\'ı geçersiz kılar', async () => {
  const old = bridge.token;
  bridge.regenerate();
  assert.notEqual(bridge.token, old);
  assert.equal((await req('GET', '/ping', { headers: { 'x-m3u8-token': old } })).status, 401);
});
