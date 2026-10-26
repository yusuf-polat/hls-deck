'use strict';

const URI_ATTR = /URI="([^"]+)"/g;

function abs(u, base) {
  try { return new URL(u, base).href; } catch { return null; }
}

/** m3u8 içindeki segment/variant satırlarını ve URI="..." alanlarını toProxy(mutlakUrl) ile değiştirir. */
function rewritePlaylist(text, base, toProxy) {
  return text.split(/\r?\n/).map((line) => {
    const s = line.trim();
    if (!s) return line;
    if (s.startsWith('#')) {
      return line.replace(URI_ATTR, (m, u) => {
        const a = abs(u, base);
        return a ? `URI="${toProxy(a)}"` : m;
      });
    }
    const a = abs(s, base);
    return a ? toProxy(a) : line;
  }).join('\n') + '\n';
}

/** Playlist'te geçen tüm mutlak URL'ler (varyantlar, segmentler, anahtarlar). */
function playlistUris(text, base) {
  const out = [];
  rewritePlaylist(text, base, (u) => { out.push(u); return u; });
  return out;
}

function isPlaylist(contentType, head) {
  return /mpegurl/i.test(contentType || '') || head.toString('latin1').trimStart().startsWith('#EXTM3U');
}

module.exports = { rewritePlaylist, playlistUris, isPlaylist };
