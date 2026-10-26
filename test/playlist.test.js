'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rewritePlaylist, isPlaylist } = require('../src/playlist');

const P = (u) => `P(${u})`;

test('mutlak ve göreli segmentler, URI attribute’ları', () => {
  const src = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1',
    '#EXT-X-MAP:URI="/init.mp4"',
    '#EXTINF:10.0,',
    'seg1.ts',
    '#EXTINF:10.0,',
    'https://cdn.other/b1.jpg',
    '',
  ].join('\r\n');
  const out = rewritePlaylist(src, 'https://h.com/live/index.m3u8', P).split('\n');
  assert.equal(out[1], '#EXT-X-KEY:METHOD=AES-128,URI="P(https://h.com/live/key.bin)",IV=0x1');
  assert.equal(out[2], '#EXT-X-MAP:URI="P(https://h.com/init.mp4)"');
  assert.equal(out[4], 'P(https://h.com/live/seg1.ts)');
  assert.equal(out[6], 'P(https://cdn.other/b1.jpg)');
});

test('isPlaylist content-type ya da gövde ile', () => {
  assert.ok(isPlaylist('application/vnd.apple.mpegurl', Buffer.from('')));
  assert.ok(isPlaylist('text/plain', Buffer.from('\n#EXTM3U\n')));
  assert.ok(!isPlaylist('image/jpeg', Buffer.from([0x47, 0x40])));
});
