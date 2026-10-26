'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCurl, autoName } = require('../src/curl');

const h = (r, name) => r.headers.find((x) => x.name.toLowerCase() === name)?.value;

test('Chrome bash formatı (kullanıcının yapıştırdığı)', () => {
  const r = parseCurl(`curl --url 'https://t24durdencdn4.xyz/b1/mono.m3u8' \
  -H 'accept: */*' \
  -H 'origin: https://player.example.com' \
  -H 'referer: https://player.example.com/' \
  -H 'sec-ch-ua: "Not:A-Brand";v="8", "Chromium";v="156"' \
  -H 'user-agent: Mozilla/5.0 Test'`);
  assert.equal(r.url, 'https://t24durdencdn4.xyz/b1/mono.m3u8');
  assert.equal(r.headers.length, 5);
  assert.equal(h(r, 'referer'), 'https://player.example.com/');
  assert.equal(h(r, 'sec-ch-ua'), '"Not:A-Brand";v="8", "Chromium";v="156"');
});

test('Chrome cmd formatı (^ kaçışları)', () => {
  const r = parseCurl('curl ^"https://a.com/x.m3u8?a=1^&b=2^" ^\r\n  -H ^"referer: https://r.com/^" ^\r\n  -H ^"sec-ch-ua: ^\\^"Chromium^\\^";v=^\\^"156^\\^"^" ^\r\n  --compressed');
  assert.equal(r.url, 'https://a.com/x.m3u8?a=1&b=2');
  assert.equal(h(r, 'referer'), 'https://r.com/');
  assert.equal(h(r, 'sec-ch-ua'), '"Chromium";v="156"');
  assert.deepEqual(r.ignored, ['--compressed']);
});

test("$'...' ANSI-C tırnakları ve kısa seçenekler", () => {
  const r = parseCurl("curl $'https://a.com/i.m3u8' -H $'x-tok: a\\'b\\u00e7' -A UA/1 -e https://ref/ -b 'k=v' -sSL");
  assert.equal(r.url, 'https://a.com/i.m3u8');
  assert.equal(h(r, 'x-tok'), "a'bç");
  assert.equal(h(r, 'user-agent'), 'UA/1');
  assert.equal(h(r, 'referer'), 'https://ref/');
  assert.equal(h(r, 'cookie'), 'k=v');
});

test('--header=değer, -Hbitişik, tekrar eden header son değeri alır', () => {
  const r = parseCurl('curl https://a.com/i.m3u8 --header="Referer: one" -H"referer: two" -X get');
  assert.equal(r.headers.length, 1);
  assert.equal(h(r, 'referer'), 'two');
  assert.equal(r.method, 'GET');
});

test('çıplak URL', () => {
  assert.deepEqual(parseCurl('  https://a.com/i.m3u8  '), { url: 'https://a.com/i.m3u8', method: 'GET', headers: [], ignored: [] });
});

test('hatalı girdiler', () => {
  assert.throws(() => parseCurl(''), /Boş/);
  assert.throws(() => parseCurl('wget https://a'), /curl/);
  assert.throws(() => parseCurl("curl -H 'a: b'"), /URL bulunamadı/);
  assert.throws(() => parseCurl("curl 'https://a"), /tek tırnak/);
  assert.throws(() => parseCurl('curl https://a -H'), /değer eksik/);
});

test('autoName referer hostunu ve yolun sonunu kullanır', () => {
  assert.equal(autoName('https://cdn.x/b1/mono.m3u8', [{ name: 'Referer', value: 'https://player.site.com/' }]), 'player.site.com · b1/mono');
  assert.equal(autoName('https://cdn.x/'), 'cdn.x');
});

test('toCurl → parseCurl gidiş-dönüş (tek tırnak dahil)', () => {
  const { toCurl } = require('../src/curl');
  const headers = [{ name: 'Referer', value: "https://a.com/it's" }, { name: 'sec-ch-ua', value: '"Chromium";v="156"' }];
  const r = parseCurl(toCurl('https://a.com/x.m3u8?a=1&b=2', headers));
  assert.equal(r.url, 'https://a.com/x.m3u8?a=1&b=2');
  assert.deepEqual(r.headers, headers);
});
