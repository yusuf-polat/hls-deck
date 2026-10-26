'use strict';
// m3u8 isteklerini gerçek request header'larıyla (Referer/Origin/Cookie dahil) yakalar ve
// HLS Deck'in 127.0.0.1 köprüsüne gönderir.

const DEFAULTS = { port: 17865, token: '', autoSend: true, playOnSend: false };
const M3U8_PATH_RE = /\.m3u8$/i;
const NOT_PLAYLIST_CTYPE = /json|html|javascript|xml/i;
const TYPES = ['xmlhttprequest', 'media', 'other'];
const MAX_ITEMS_PER_TAB = 30;
const MAX_RESOLVERS_PER_TAB = 10;
// Her imzalamada değişen parametreler (uygulamadaki src/token.js ile aynı liste)
const VOLATILE = /^(st|e|exp|expires|expiry|token|tkn|hdnts|hdntl|sig|signature|hash|md5|auth|wmsauthsign|validfrom|validto|policy|key-pair-id|sid|nimblesessionid)$/i;

/** İmzadan bağımsız yayın kimliği: aynı yayının yeni token'lı adresi aynı anahtarı verir. */
function streamKey(url) {
  try {
    const u = new URL(url);
    const keep = [...u.searchParams].filter(([k, v]) => !VOLATILE.test(k) && !(/^\d+$/.test(k) && v === '')).sort(([a], [b]) => a.localeCompare(b));
    return `${u.origin}${u.pathname}?${new URLSearchParams(keep)}`;
  } catch { return url; }
}
const pathKey = (url) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; } };

/** Query'sinde m3u8 adresi taşıyan istek (token servisi adayı): gömülü playlist'lerin yol anahtarları. */
function embeddedPlaylists(url) {
  try {
    return [...new URL(url).searchParams.values()]
      .filter((v) => /^https?:\/\//i.test(v) && M3U8_PATH_RE.test(new URL(v).pathname))
      .map(pathKey);
  } catch { return []; }
}

// requestId -> yakalanan istek; yanıt header'ları gelene kadar tutulur (content-type ile tanıma için)
const pending = new Map();

const CLIENT = `extension/${chrome.runtime.getManifest().version}`;

// Uygulamanın kurduğu kopyada bootstrap.json bulunur, port/token elle girilmez. Uygulamada token
// yenilenince dosya da güncellenir: son devralınan token'dan farklıysa yenisini al. Elle kurulan
// (bootstrap.json'suz) kopyada fetch başarısız olur ve ayarlar olduğu gibi kalır.
async function syncBootstrap() {
  let b;
  try {
    const res = await fetch(chrome.runtime.getURL('bootstrap.json'), { cache: 'no-store' });
    if (!res.ok) return;
    b = await res.json();
  } catch { return; }
  if (!/^[0-9a-f]{32}$/.test(b?.token || '')) return;
  const { bootstrapToken } = await chrome.storage.local.get('bootstrapToken');
  if (bootstrapToken === b.token) return;
  await chrome.storage.local.set({ token: b.token, port: Number(b.port) || DEFAULTS.port, bootstrapToken: b.token });
}

async function getCfg() {
  await syncBootstrap();
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

// Kurulur kurulmaz uygulamaya kendini bildir (ilk açılış sihirbazı "bağlandı" görsün)
async function announce() {
  const cfg = await getCfg();
  if (cfg.token) await api(cfg, 'GET', '/ping').catch(() => {});
}
chrome.runtime.onInstalled.addListener(announce);
chrome.runtime.onStartup.addListener(announce);
const tabKey = (tabId) => `tab:${tabId}`;

async function getTab(tabId) {
  const k = tabKey(tabId);
  const st = (await chrome.storage.session.get(k))[k] || { items: [], autoSent: false };
  st.resolvers ||= [];
  return st;
}
const setTab = (tabId, st) => chrome.storage.session.set({ [tabKey(tabId)]: st });

// Aynı sekmeye eşzamanlı gelen playlist'ler durumu ezmesin diye sekme başına sıralı işle
const queues = new Map();
function withTab(tabId, fn) {
  const next = (queues.get(tabId) || Promise.resolve()).then(fn, fn);
  queues.set(tabId, next.catch(() => {}));
  return next;
}

// ---------- yakalama ----------
chrome.webRequest.onBeforeRequest.addListener((d) => {
  // Sekmede yeni sayfa açıldı: listeyi ve otomatik gönderim hakkını sıfırla
  if (d.tabId >= 0) withTab(d.tabId, async () => { await setTab(d.tabId, { items: [], autoSent: false, resolvers: [] }); updateBadge(d.tabId); });
}, { urls: ['<all_urls>'], types: ['main_frame'] });

chrome.webRequest.onSendHeaders.addListener((d) => {
  if (d.tabId < 0 || d.method !== 'GET' || d.initiator?.startsWith('chrome-extension://')) return;
  pending.set(d.requestId, {
    url: d.url,
    tabId: d.tabId,
    headers: (d.requestHeaders || []).map((h) => ({ name: h.name, value: h.value ?? '' })),
  });
  if (pending.size > 1000) pending.delete(pending.keys().next().value);
}, { urls: ['<all_urls>'], types: TYPES }, ['requestHeaders', 'extraHeaders']);

chrome.webRequest.onHeadersReceived.addListener((d) => {
  const p = pending.get(d.requestId);
  pending.delete(d.requestId);
  if (!p || d.statusCode >= 400) return;
  const ctype = d.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-type')?.value || '';
  // .m3u8 yalnızca path'te aranır: query'de m3u8 adresi taşıyan token servisleri
  // (…/secure?url=…aspor.m3u8 → JSON) playlist sanılmasın
  const isPlaylist = /mpegurl/i.test(ctype) || (M3U8_PATH_RE.test(new URL(d.url).pathname) && !NOT_PLAYLIST_CTYPE.test(ctype));
  if (isPlaylist) return withTab(p.tabId, () => onPlaylist(p));
  const targets = embeddedPlaylists(d.url);
  if (targets.length) withTab(p.tabId, () => onResolver(p, targets));
}, { urls: ['<all_urls>'], types: TYPES }, ['responseHeaders']);

chrome.webRequest.onErrorOccurred.addListener((d) => pending.delete(d.requestId), { urls: ['<all_urls>'], types: TYPES });

chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove(tabKey(tabId)); queues.delete(tabId); });

async function onResolver(p, targets) {
  const st = await getTab(p.tabId);
  st.resolvers = [{ url: p.url, headers: p.headers, targets, at: Date.now() },
    ...st.resolvers.filter((r) => streamKey(r.url) !== streamKey(p.url))].slice(0, MAX_RESOLVERS_PER_TAB);
  await setTab(p.tabId, st);
}

async function onPlaylist(p) {
  const st = await getTab(p.tabId);
  const resolver = st.resolvers.find((r) => r.targets.includes(pathKey(p.url)));
  const key = streamKey(p.url);
  const existing = st.items.find((i) => i.url === p.url || streamKey(i.url) === key);
  if (existing) {
    // Canlı yayın playlist'i sürekli yenilenir; header'ları (token/cookie) ve imzalı adresi güncel tut
    const renewed = existing.url !== p.url;
    existing.url = p.url;
    existing.headers = p.headers;
    existing.lastSeen = Date.now();
    if (resolver) existing.resolver = { url: resolver.url, headers: resolver.headers };
    // Sayfadaki oynatıcı token'ı yeniledi: uygulamaya giden yayını da tazele (token servisi
    // bilinen yayını uygulama zaten kendisi yeniler)
    if (renewed && existing.status === 'sent' && !existing.resolver) {
      const cfg = await getCfg();
      if (cfg.token) await sendItem(existing, false, cfg);
    }
    await setTab(p.tabId, st);
    return;
  }
  let page = {};
  try { page = await chrome.tabs.get(p.tabId); } catch { /* sekme kapanmış */ }
  const item = {
    url: p.url, headers: p.headers, pageUrl: page.url || '', pageTitle: page.title || '',
    firstSeen: Date.now(), lastSeen: Date.now(), status: 'new', message: '',
    // m3u8 bir token servisinden geldiyse uygulamaya servisi gönder: süre dolunca oradan yeniler
    resolver: resolver ? { url: resolver.url, headers: resolver.headers } : null,
  };
  st.items.unshift(item);
  st.items.length = Math.min(st.items.length, MAX_ITEMS_PER_TAB);

  // Otomatik gönderim sayfa başına yalnızca ilk playlist için: sonrakiler genelde aynı yayının
  // kalite varyantlarıdır (master -> media). Diğerleri popup'tan elle gönderilebilir.
  const cfg = await getCfg();
  if (cfg.autoSend && cfg.token && !st.autoSent) {
    st.autoSent = true;
    await sendItem(item, cfg.playOnSend, cfg);
  }
  await setTab(p.tabId, st);
  updateBadge(p.tabId, st);
}

// ---------- gönderim ----------
async function api(cfg, method, pathname, body) {
  const res = await fetch(`http://127.0.0.1:${cfg.port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-m3u8-token': cfg.token, 'x-m3u8-client': CLIENT },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 401 ? 'Token hatalı (uygulamadaki 🧩 penceresinden kopyala)' : data.error || `HTTP ${res.status}`);
  return data;
}

function explain(e) {
  return e instanceof TypeError || e.name === 'TimeoutError'
    ? 'Uygulamaya ulaşılamadı: HLS Deck açık mı?' : e.message;
}

async function sendItem(item, play, cfg) {
  try {
    const src = item.resolver || item;
    const r = await api(cfg, 'POST', '/import', {
      url: src.url, headers: src.headers, pageUrl: item.pageUrl, pageTitle: item.pageTitle, play,
    });
    item.status = 'sent';
    item.message = `${r.created ? 'Eklendi' : 'Güncellendi'}: ${r.stream.name}`;
  } catch (e) {
    item.status = 'error';
    item.message = explain(e);
  }
  return item;
}

async function updateBadge(tabId, st) {
  st = st || await getTab(tabId);
  const n = st.items.length;
  const err = st.items.some((i) => i.status === 'error');
  const sent = st.items.some((i) => i.status === 'sent');
  try {
    await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: err ? '#d93025' : sent ? '#188038' : '#4f8cff' });
  } catch { /* sekme kapanmış */ }
}

// ---------- popup mesajları ----------
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    const cfg = await getCfg();
    switch (msg.type) {
      case 'cfg':
        return cfg;
      case 'list':
        return getTab(msg.tabId);
      case 'send':
        return withTab(msg.tabId, async () => {
          const st = await getTab(msg.tabId);
          const item = st.items.find((i) => i.url === msg.url);
          if (!item) throw new Error('Kayıt bulunamadı');
          if (!cfg.token) throw new Error('Önce ayarlardan token gir');
          await sendItem(item, Boolean(msg.play), cfg);
          await setTab(msg.tabId, st);
          updateBadge(msg.tabId, st);
          return item;
        });
      case 'clear':
        return withTab(msg.tabId, async () => { await setTab(msg.tabId, { items: [], autoSent: true, resolvers: [] }); updateBadge(msg.tabId); return true; });
      case 'ping':
        try { return { ok: true, ...(await api({ ...cfg, ...msg.cfg }, 'GET', '/ping')) }; }
        catch (e) { return { ok: false, error: explain(e) }; }
      default:
        throw new Error(`bilinmeyen mesaj: ${msg.type}`);
    }
  })().then((r) => reply({ result: r }), (e) => reply({ error: e.message }));
  return true; // asenkron yanıt
});
