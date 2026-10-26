'use strict';
// Süreli imzalı (st/e, token, hdnts…) m3u8 adresleri ve token servisleri.
// Bazı siteler m3u8'i doğrudan değil, JSON dönen bir token servisi üzerinden verir:
//   securevideotoken…/secure?…&url=…aspor.m3u8 → {"Url":"https://…/aspor.m3u8?st=…&e=…"}
// İmza master'dan varyant playlist'lere ve segmentlere query olarak taşınır; süresi dolunca CDN 403 döner.
// TokenSession kaynağı yeniden çözüp eski URL'leri taze imzalı karşılıklarına çevirir.
const { isPlaylist, playlistUris } = require('./playlist');

// Her imzalamada değişen parametreler; yayın kimliği (streamKey) bunlar olmadan hesaplanır
const VOLATILE = /^(st|e|exp|expires|expiry|token|tkn|hdnts|hdntl|sig|signature|hash|md5|auth|wmsauthsign|validfrom|validto|policy|key-pair-id|sid|nimblesessionid)$/i;
const EXPIRY_PARAM = /^(e|exp|expires|expiry)$/i;
const AUTH_FAILURE = new Set([401, 403, 410]);
const EXPIRY_MARGIN_MS = 60 * 1000;
const MIN_REFRESH_INTERVAL_MS = 5000;
const MAX_KNOWN = 2000;
const URL_KEY_PREF = /^(url|src|file|hls|stream|source|playlist|m3u8|link)/i;

// `?525688` gibi değersiz sayısal anahtarlar önbellek kırıcıdır
const isVolatile = (k, v) => VOLATILE.test(k) || (/^\d+$/.test(k) && v === '');

/** Yayının imzadan bağımsız kimliği: origin + path + kalıcı query parametreleri. */
function streamKey(url) {
  try {
    const u = new URL(url);
    const keep = [...u.searchParams].filter(([k, v]) => !isVolatile(k, v)).sort(([a], [b]) => a.localeCompare(b));
    return `${u.origin}${u.pathname}?${new URLSearchParams(keep)}`;
  } catch {
    return url;
  }
}

/** URL'deki son kullanma zamanı (ms) ya da null. */
function expiresAt(url) {
  try {
    for (const [k, v] of new URL(url).searchParams) {
      if (!EXPIRY_PARAM.test(k)) continue;
      if (/^\d{10}$/.test(v)) return Number(v) * 1000;
      if (/^\d{13}$/.test(v)) return Number(v);
    }
  } catch { /* geçersiz URL */ }
  return null;
}

/**
 * target'ta bulunan imza parametrelerini fresh'teki değerlerle değiştirir (aynı token çoğunlukla
 * master, varyant ve farklı host'taki segmentlerde ortak). Değişiklik yoksa null.
 */
function applyTokens(target, fresh) {
  let t, f;
  try { t = new URL(target); f = new URL(fresh); } catch { return null; }
  let changed = false;
  for (const [k, v] of f.searchParams) {
    if (!VOLATILE.test(k) || k.toLowerCase() === 'sid' || !t.searchParams.has(k) || t.searchParams.get(k) === v) continue;
    t.searchParams.set(k, v);
    changed = true;
  }
  return changed ? t.href : null;
}

/** Token servisinin yanıtından (JSON, HTML ya da düz metin) m3u8 adresini çıkarır. */
function extractPlaylistUrl(text, base) {
  const candidates = [];
  const visit = (v, key) => {
    if (typeof v === 'string') {
      if (/^https?:\/\//i.test(v) || (key && URL_KEY_PREF.test(key) && /\.m3u8/i.test(v))) candidates.push({ v, key: key || '' });
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  try { visit(JSON.parse(text)); } catch { /* JSON değil */ }
  const rank = (c) => (/\.m3u8/i.test(c.v) ? 0 : 2) + (URL_KEY_PREF.test(c.key) ? 0 : 1);
  const best = candidates.filter((c) => /\.m3u8|mpegurl/i.test(c.v) || URL_KEY_PREF.test(c.key))
    .sort((a, b) => rank(a) - rank(b))[0];
  const raw = best?.v || text.replace(/\\\//g, '/').match(/https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/i)?.[0];
  if (!raw) return null;
  try { return new URL(raw.replace(/&amp;/g, '&'), base).href; } catch { return null; }
}

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}`);
    this.status = status;
    this.url = url;
  }
}

/**
 * Kaynağı oynatılabilir playlist URL'ine çözer.
 * @param {string} url m3u8 ya da token servisi adresi
 * @param {(url: string) => Promise<Response>} fetchImpl header'ları ekleyen fetch
 */
async function resolveSource(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new HttpError(res.status, url);
  const body = Buffer.from(await res.arrayBuffer());
  const finalUrl = res.url || url;
  if (isPlaylist(res.headers.get('content-type'), body.subarray(0, 64))) {
    return { playlistUrl: finalUrl, resolver: false, body: body.toString('utf8') };
  }
  const found = extractPlaylistUrl(body.subarray(0, 1 << 20).toString('utf8'), finalUrl);
  if (!found) throw new Error('Adres bir m3u8 değil ve yanıtında m3u8 adresi bulunamadı');
  return { playlistUrl: found, resolver: true, body: null };
}

class TokenSession {
  /**
   * @param {{source: () => string, fetch: (url: string) => Promise<Response>}} opts
   *   source: yayının güncel kaynak adresi (eklenti yeni imzalı adres gönderirse değişir)
   */
  constructor({ source, fetch: fetchImpl }) {
    this.source = source;
    this.fetch = fetchImpl;
    this.master = null; // en son çözülen playlist URL'i
    this.resolver = false;
    this.known = new Map(); // streamKey -> en taze imzalı URL
    this.refreshing = null;
    this.lastRefresh = 0;
  }

  learn(url) {
    const k = streamKey(url);
    this.known.delete(k);
    this.known.set(k, url);
    if (this.known.size > MAX_KNOWN) this.known.delete(this.known.keys().next().value);
  }

  async #resolve() {
    const r = await resolveSource(this.source(), this.fetch);
    let body = r.body;
    let base = r.playlistUrl;
    if (body === null) {
      // Token servisi: varyant adreslerini (yeni sid/st/e ile) öğrenmek için master'ı da al
      const res = await this.fetch(r.playlistUrl);
      if (!res.ok) throw new HttpError(res.status, r.playlistUrl);
      body = await res.text();
      base = res.url || r.playlistUrl;
    }
    this.resolver = r.resolver;
    this.master = r.playlistUrl;
    this.learn(r.playlistUrl);
    for (const u of playlistUris(body, base)) this.learn(u);
    return r;
  }

  async start() {
    const r = await this.#resolve();
    this.lastRefresh = Date.now();
    return r;
  }

  /** İstenen (belki eskimiş) URL'in bilinen en taze imzalı karşılığı. */
  current(url) {
    const u = this.known.get(streamKey(url)) || url;
    return (this.master && applyTokens(u, this.master)) || u;
  }

  /** URL'in imzası dolmuş ya da dolmak üzere mi? */
  expiring(url, now = Date.now()) {
    const exp = expiresAt(url);
    return exp !== null && exp - now < EXPIRY_MARGIN_MS;
  }

  /** Kaynağı yeniden çözer; eşzamanlı çağrılar tek isteği paylaşır. Yeni imza geldiyse true. */
  refresh({ force = false } = {}) {
    if (this.refreshing) return this.refreshing;
    if (!force && Date.now() - this.lastRefresh < MIN_REFRESH_INTERVAL_MS) return Promise.resolve(false);
    const before = this.master;
    this.refreshing = this.#resolve()
      .then(() => this.master !== before)
      .finally(() => { this.lastRefresh = Date.now(); this.refreshing = null; });
    return this.refreshing;
  }
}

module.exports = {
  streamKey, expiresAt, applyTokens, extractPlaylistUrl, resolveSource, TokenSession, HttpError, AUTH_FAILURE,
};
