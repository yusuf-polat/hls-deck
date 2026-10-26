'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { streamKey, expiresAt, applyTokens, extractPlaylistUrl, TokenSession } = require('../src/token');

// securevideotoken.tmgrup.com.tr'nin gerçek yanıt biçimi (2026-10)
const TMGRUP = '{"Success":true,"Url":"https://trkvz.daioncdn.net/aspor/aspor.m3u8?ce=3&app=45f8&st=rc2kIw9EfFIqbWTUXiNIiQ&e=1793094408",'
  + '"AlternateUrl":"https://trkvz-dvr-live.ercdn.net/aspor/index.m3u8?st=rc2kIw9EfFIqbWTUXiNIiQ&e=1793094408","Time":41600,"IP":"1.2.3.4"}';

test('streamKey imza parametrelerini ve sayısal önbellek kırıcıyı yok sayar', () => {
  assert.equal(
    streamKey('https://h/a/aspor.m3u8?ce=3&app=x&st=AAA&e=1793094408'),
    streamKey('https://h/a/aspor.m3u8?e=1793099999&st=BBB&app=x&ce=3'),
  );
  assert.equal(
    streamKey('https://t/webtv/secure?525688&url=https%3A%2F%2Fh%2Fa.m3u8'),
    streamKey('https://t/webtv/secure?912345&url=https%3A%2F%2Fh%2Fa.m3u8'),
  );
  assert.notEqual(streamKey('https://h/live.m3u8?channel=1'), streamKey('https://h/live.m3u8?channel=2'));
});

test('expiresAt saniye/milisaniye', () => {
  assert.equal(expiresAt('https://h/a.m3u8?st=x&e=1793062340'), 1793062340000);
  assert.equal(expiresAt('https://h/a.m3u8?expires=1793062340123'), 1793062340123);
  assert.equal(expiresAt('https://h/a.m3u8?e=abc'), null);
  assert.equal(expiresAt('https://h/a.m3u8'), null);
});

test('applyTokens: yalnızca hedefte olan imza parametrelerini taze değerle değiştirir, sid korunur', () => {
  const seg = 'https://cdn2.ercdn.net/x/aspor_720p-1.ts?e=100&st=OLD';
  const master = 'https://trkvz.daioncdn.net/aspor/aspor.m3u8?ce=3&st=NEW&e=200';
  assert.equal(applyTokens(seg, master), 'https://cdn2.ercdn.net/x/aspor_720p-1.ts?e=200&st=NEW');
  assert.equal(applyTokens('https://h/v.m3u8?st=OLD&sid=s1', 'https://h/m.m3u8?st=NEW&sid=s2'), 'https://h/v.m3u8?st=NEW&sid=s1');
  assert.equal(applyTokens('https://h/plain.ts', master), null);
  assert.equal(applyTokens(master, master), null);
});

test('extractPlaylistUrl: tmgrup JSON → Url (AlternateUrl değil)', () => {
  assert.equal(extractPlaylistUrl(TMGRUP, 'https://securevideotoken.tmgrup.com.tr/webtv/secure'),
    'https://trkvz.daioncdn.net/aspor/aspor.m3u8?ce=3&app=45f8&st=rc2kIw9EfFIqbWTUXiNIiQ&e=1793094408');
  assert.equal(extractPlaylistUrl('{"data":{"hls":"/live/a.m3u8?t=1"}}', 'https://x.com/api'), 'https://x.com/live/a.m3u8?t=1');
  assert.equal(extractPlaylistUrl('<script>var src="https:\\/\\/c.net\\/s\\/index.m3u8?token=a&amp;e=1";</script>', 'https://x'),
    'https://c.net/s/index.m3u8?token=a&e=1');
  assert.equal(extractPlaylistUrl('{"ok":false}', 'https://x'), null);
});

// ---------- uçtan uca: token döndüren sahte servis + imza doğrulayan sahte CDN ----------
function fakeCdn() {
  const st = { token: 'T1', exp: 2000000000, resolverHits: 0 };
  const ok = (u) => u.searchParams.get('st') === st.token && u.searchParams.get('e') === String(st.exp);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const base = `http://${req.headers.host}`;
    if (req.headers.referer !== 'https://site/') { res.writeHead(403); return res.end(); }
    if (u.pathname === '/secure') {
      st.resolverHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ Success: true, Url: `${base}/live/master.m3u8?ce=3&st=${st.token}&e=${st.exp}` }));
    }
    if (!ok(u)) { res.writeHead(403); return res.end(); }
    const q = `e=${st.exp}&st=${st.token}`;
    res.writeHead(200, { 'content-type': u.pathname.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl' });
    if (u.pathname === '/live/master.m3u8') return res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv720.m3u8?${q}&sid=${Math.random().toString(36).slice(2)}&ce=3\n`);
    if (u.pathname === '/live/v720.m3u8') return res.end(`#EXTM3U\n#EXTINF:10\n${base}/seg/1.ts?${q}\n`);
    return res.end(Buffer.from([0x47]));
  });
  return { st, server };
}

test('TokenSession: token servisi çözülür, imza dönünce eski varyant/segment adresleri tazelenir', async (t) => {
  const { st, server } = fakeCdn();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = (url) => fetch(url, { headers: { referer: 'https://site/' } });
  const s = new TokenSession({ source: () => `${base}/secure?525688&url=${encodeURIComponent(`${base}/live/master.m3u8?ce=3`)}`, fetch: fetchImpl });

  const r = await s.start();
  assert.equal(r.resolver, true);
  assert.equal(r.playlistUrl, `${base}/live/master.m3u8?ce=3&st=T1&e=2000000000`);

  // Oynatıcının elindeki adresler (eski imzalı)
  const oldVariant = [...s.known.values()].find((u) => u.includes('v720'));
  const oldSeg = `${base}/seg/1.ts?e=2000000000&st=T1`;
  assert.equal((await fetchImpl(s.current(oldVariant))).status, 200);

  // CDN imzayı döndürdü: eski adresler 403
  st.token = 'T2';
  st.exp = 2000000600;
  assert.equal((await fetchImpl(oldVariant)).status, 403);

  s.lastRefresh = 0; // 5 sn sınırını testte atla
  assert.equal(await s.refresh(), true);
  assert.equal(st.resolverHits, 2);
  const freshVariant = s.current(oldVariant);
  assert.match(freshVariant, /st=T2/);
  assert.equal((await fetchImpl(freshVariant)).status, 200);
  assert.equal((await fetchImpl(s.current(oldSeg))).status, 200);

  // Eşzamanlı yenilemeler tek isteği paylaşır; kısa aralıkta tekrar yenilenmez
  const hits = st.resolverHits;
  s.lastRefresh = 0;
  await Promise.all([s.refresh(), s.refresh(), s.refresh()]);
  assert.equal(st.resolverHits, hits + 1);
  assert.equal(await s.refresh(), false);
  assert.equal(st.resolverHits, hits + 1);
});

test('TokenSession: doğrudan imzalı m3u8, kaynak adresi güncellenince yeni imzayı kullanır', async (t) => {
  const { st, server } = fakeCdn();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = (url) => fetch(url, { headers: { referer: 'https://site/' } });
  let source = `${base}/live/master.m3u8?ce=3&st=T1&e=2000000000`;
  const s = new TokenSession({ source: () => source, fetch: fetchImpl });
  assert.equal((await s.start()).resolver, false);

  st.token = 'T3';
  await assert.rejects(s.refresh({ force: true }), (e) => e.status === 403); // eski adresle yenilenemez
  source = `${base}/live/master.m3u8?ce=3&st=T3&e=2000000000`; // eklenti yeni adresi gönderdi
  assert.equal(await s.refresh({ force: true }), true);
  assert.equal((await fetchImpl(s.current(`${base}/seg/1.ts?e=2000000000&st=T1`))).status, 200);
});

test('expiring: son 60 sn', () => {
  const s = new TokenSession({ source: () => '', fetch: null });
  const now = 1_800_000_000_000;
  assert.equal(s.expiring(`https://h/a.ts?e=${now / 1000 + 30}`, now), true);
  assert.equal(s.expiring(`https://h/a.ts?e=${now / 1000 + 3600}`, now), false);
  assert.equal(s.expiring('https://h/a.ts', now), false);
});
