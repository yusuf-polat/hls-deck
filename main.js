'use strict';
const { app, BrowserWindow, ipcMain, protocol, dialog, Menu, clipboard, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { parseCurl, autoName, toCurl } = require('./src/curl');
const { rewritePlaylist, isPlaylist } = require('./src/playlist');
const { Store } = require('./src/store');
const { Bridge, DEFAULT_PORT } = require('./src/bridge');
const { ExtensionSetup } = require('./src/extension-setup');
const { TokenSession, AUTH_FAILURE, streamKey, expiresAt } = require('./src/token');

const SCHEME = 'stream';
// Node fetch'in kendisinin yönettiği ya da elle gönderilmemesi gereken header'lar
const DROP_HEADERS = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding',
  'upgrade', 'accept-encoding', 'te', 'expect', 'proxy-connection']);
const CORS = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
const FETCH_TIMEOUT_MS = 20000;

const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const smokeArg = argValue('smoke');
const profileArg = argValue('profile');
const bridgePort = Number(argValue('bridge-port')) || DEFAULT_PORT;
const verbose = process.argv.includes('--verbose') || Boolean(smokeArg);
if (smokeArg) app.setPath('userData', path.join(app.getPath('temp'), 'hls-deck-smoke'));
else if (profileArg) app.setPath('userData', path.resolve(profileArg));

// Köprü portu tek olduğu için aynı profilde ikinci kopya açılmasın; açılırsa mevcut pencere öne gelsin
if (!smokeArg && !app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

let win;
let store;
let bridge;
let extSetup;
let activeHeaders = {};
let activeId = null;
let session = null; // oynayan yayının token oturumu (süreli imzaları yeniler)

const toProxy = (u) => `${SCHEME}://p/?u=${encodeURIComponent(u)}`;

function setActiveHeaders(headers) {
  activeHeaders = {};
  for (const { name, value } of headers || []) {
    const k = String(name).trim().toLowerCase();
    if (!k || k.startsWith(':') || DROP_HEADERS.has(k)) continue;
    activeHeaders[k] = String(value);
  }
}

function report(err) {
  if (verbose) console.log('[upstream]', JSON.stringify(err));
  win?.webContents.send('upstream-error', err);
}

const upstream = (url) => fetch(url, { headers: activeHeaders, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

/** Token'ı yeniler; başarısızlığı arayüze bildirir. Yeni imza geldiyse true. */
async function refreshToken(reason, opts) {
  const s = session;
  if (!s) return false;
  try {
    const changed = await s.refresh(opts);
    if (changed && s === session) {
      if (verbose) console.log('[token] yenilendi:', reason, '→', s.master);
      win?.webContents.send('token-refreshed', { reason, expiresAt: expiresAt(s.master) });
    }
    return changed;
  } catch (e) {
    report({ url: s.source(), status: e.status || 0, message: `token yenilenemedi: ${e.message}` });
    return false;
  }
}

async function handleStream(request) {
  const requested = new URL(request.url).searchParams.get('u') || '';
  if (!/^https?:\/\//i.test(requested)) return new Response('bad url', { status: 400, headers: CORS });

  // hls.js eski imzalı URL'leri tekrar isteyebilir (canlı varyant playlist'i): en tazesine çevir
  let target = session ? session.current(requested) : requested;
  if (session?.expiring(target)) {
    await refreshToken('süre doluyor');
    target = session ? session.current(requested) : target;
  }

  let res;
  try {
    res = await upstream(target);
    if (session && AUTH_FAILURE.has(res.status)) {
      await refreshToken(`HTTP ${res.status}`);
      const fresh = session ? session.current(requested) : target;
      if (fresh !== target) {
        target = fresh;
        res = await upstream(target);
      }
    }
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? 'zaman aşımı' : (e.cause?.code || e.message);
    report({ url: target, status: 0, message: msg });
    return new Response(String(msg), { status: 502, headers: CORS });
  }
  if (!res.ok) {
    report({ url: target, status: res.status, message: res.statusText });
    return new Response(`upstream ${res.status}`, { status: res.status, headers: CORS });
  }

  const body = Buffer.from(await res.arrayBuffer());
  const ctype = res.headers.get('content-type') || 'application/octet-stream';
  if (isPlaylist(ctype, body.subarray(0, 64))) {
    const s = session;
    const text = rewritePlaylist(body.toString('utf8'), res.url || target, (u) => { s?.learn(u); return toProxy(u); });
    return new Response(text, { headers: { ...CORS, 'content-type': 'application/vnd.apple.mpegurl' } });
  }
  // Segmentler sıklıkla .jpg/.png kılığında MPEG-TS olarak gelir
  return new Response(body, { headers: { ...CORS, 'content-type': body[0] === 0x47 ? 'video/mp2t' : ctype } });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#0e0f12',
    title: 'HLS Deck',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    show: !smokeArg,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (verbose) {
    win.webContents.on('console-message', (e) => console.log(`[console:${e.level}]`, e.message, e.sourceId ? `(${path.basename(e.sourceId)}:${e.lineNumber})` : ''));
    win.webContents.on('preload-error', (_e, p, err) => console.log('[preload-error]', p, err.message));
  }
  if (smokeArg) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('smoke', fs.readFileSync(smokeArg, 'utf8'));
    });
    setTimeout(() => { console.log('SMOKE FAIL: zaman aşımı'); app.exit(1); }, 45000);
  }
}

/**
 * Aynı URL kayıtlıysa header'larını (ve verilen diğer alanları) tazeler, yoksa yeni kayıt açar.
 * Hızlı oynat kutusu ve Chrome eklentisi köprüsü bunu ortak kullanır.
 */
function importStream({ url, headers, curl, name, pageUrl, source = 'manual' }) {
  // Süreli imzalı adresler her seferinde değişir (st/e…): aynı yayını imzadan bağımsız anahtarla bul
  const key = streamKey(url);
  const ex = store.findByUrl(url) || store.items.find((s) => streamKey(s.url) === key);
  if (ex) {
    const patch = { id: ex.id, url, headers: headers.length ? headers : ex.headers, curl: curl || ex.curl };
    if (pageUrl) patch.pageUrl = pageUrl;
    return { stream: store.upsert(patch), created: false };
  }
  const stream = store.upsert({
    name: name || autoName(url, headers), url, headers, curl: curl || '', pageUrl: pageUrl || '', source,
  });
  return { stream, created: true };
}

function onBridgeImport({ url, headers, pageUrl, pageTitle, play }) {
  let name = pageTitle.replace(/\s+/g, ' ').trim().slice(0, 80);
  // Aynı sayfadan gelen ikinci playlist (ör. kalite varyantı) listede ayırt edilebilsin
  if (name && store.items.some((s) => s.name === name && s.url !== url)) {
    const tail = new URL(url).pathname.split('/').filter(Boolean).pop()?.replace(/\.m3u8$/i, '');
    if (tail) name = `${name} · ${tail}`;
  }
  const r = importStream({ url, headers, curl: toCurl(url, headers), name, pageUrl, source: 'extension' });
  if (verbose) console.log('[bridge] import', r.created ? 'yeni' : 'güncellendi', r.stream.name);
  // Oynayan yayının token/cookie'leri tazelendiyse kesinti olmadan sonraki isteklerde kullan
  if (r.stream.id === activeId) {
    setActiveHeaders(r.stream.headers);
    if (!r.created) refreshToken('eklentiden yeni adres', { force: true });
  }
  win?.webContents.send('bridge-import', { stream: r.stream, created: r.created, play });
  if (play && win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  return r;
}

function explainStartError(e, url) {
  const exp = expiresAt(url);
  if (e.status && AUTH_FAILURE.has(e.status) && exp && exp < Date.now()) {
    return `Sunucu ${e.status} döndü: adresin imzası ${new Date(exp).toLocaleString('tr-TR')} tarihinde dolmuş. `
      + 'Sayfayı tarayıcıda yeniden aç (eklenti yeni adresi otomatik alır) ya da cURL\'ü yenile.';
  }
  if (e.status) {
    return `Sunucu ${e.status} döndü. Header'lar (Referer/Origin/Cookie) ya da adresteki token eskimiş olabilir; `
      + 'sayfayı tarayıcıda yeniden aç ya da cURL\'ü yenile.';
  }
  if (e.name === 'TimeoutError') return 'Kaynak 20 sn içinde yanıt vermedi (zaman aşımı).';
  const code = e.cause?.code || '';
  const NET = {
    ENOTFOUND: 'Sunucu bulunamadı: adres yanlış ya da internet bağlantısı yok.',
    EAI_AGAIN: 'Sunucu adı çözülemedi: internet bağlantısını kontrol et.',
    ECONNREFUSED: 'Sunucu bağlantıyı reddetti.',
    ECONNRESET: 'Sunucu bağlantıyı kesti (bölge kısıtlaması ya da engelleme olabilir).',
    ETIMEDOUT: 'Sunucuya bağlanılamadı (zaman aşımı).',
  };
  if (NET[code]) return `${NET[code]} (${code})`;
  if (/CERT|SSL|TLS/i.test(code)) return `Güvenli bağlantı kurulamadı: sertifika hatası (${code}).`;
  return code ? `${e.message} (${code})` : e.message;
}

function onBridgeClient(client) {
  if (client.name.startsWith('extension/')) extSetup.markConnected(client.name);
  win?.webContents.send('bridge-client', client);
}

function registerIpc() {
  const safe = (fn) => async (_e, ...args) => {
    try { return await fn(...args); } catch (e) { return { error: e.message }; }
  };

  ipcMain.handle('curl:parse', safe((text) => parseCurl(text)));
  ipcMain.handle('streams:list', safe(() => store.list()));
  ipcMain.handle('streams:save', safe((s) => {
    if (!s?.url || !/^https?:\/\//i.test(s.url)) throw new Error('Geçerli bir http(s) URL gerekli');
    return store.upsert({ ...s, name: s.name?.trim() || autoName(s.url, s.headers) });
  }));
  ipcMain.handle('streams:delete', safe((id) => store.remove(id)));

  ipcMain.handle('streams:import-curl', safe((text) => {
    const p = parseCurl(text);
    const raw = text.trim().startsWith('http') ? '' : text.trim();
    return { ...importStream({ url: p.url, headers: p.headers, curl: raw }), ignored: p.ignored };
  }));

  ipcMain.handle('bridge:info', safe(() => bridge.info()));
  ipcMain.handle('bridge:regenerate', safe(() => {
    const info = bridge.regenerate();
    extSetup.refresh(); // uygulamanın kurduğu eklenti yeni token'ı bootstrap.json'dan alır
    return info;
  }));

  ipcMain.handle('ext:status', safe(() => extSetup.status()));
  ipcMain.handle('ext:install', safe(async (browserId) => {
    const r = await extSetup.install(browserId);
    // "Paketlenmemiş öğe yükle" klasör seçicisine yapıştırılabilsin / klasör sayfaya sürüklenebilsin
    clipboard.writeText(r.dir);
    shell.showItemInFolder(path.join(r.dir, 'manifest.json'));
    return r;
  }));
  ipcMain.handle('ext:reveal', safe(() => shell.showItemInFolder(path.join(extSetup.dir, 'manifest.json'))));
  ipcMain.handle('ext:skip', safe(() => extSetup.skip()));
  ipcMain.handle('clipboard:write', safe((text) => { clipboard.writeText(String(text)); return true; }));
  ipcMain.handle('shell:open', safe((url) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Yalnızca http(s) bağlantıları açılır');
    return shell.openExternal(url);
  }));

  ipcMain.handle('player:prepare', safe(async (id) => {
    const s = store.get(id);
    if (!s) throw new Error('Yayın bulunamadı');
    setActiveHeaders(s.headers);
    activeId = s.id;
    const sess = new TokenSession({ source: () => store.get(id)?.url || s.url, fetch: upstream });
    session = sess;
    let r;
    try {
      r = await sess.start();
    } catch (e) {
      if (session === sess) session = null;
      throw new Error(explainStartError(e, s.url));
    }
    if (verbose) console.log('[token] başlangıç', r.resolver ? `token servisi → ${r.playlistUrl}` : r.playlistUrl);
    return { stream: store.markPlayed(id), src: toProxy(r.playlistUrl), resolver: r.resolver, expiresAt: expiresAt(r.playlistUrl) };
  }));

  ipcMain.handle('streams:export', safe(async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `hls-deck-yayinlar-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, streams: store.list() }, null, 2));
    return { filePath, count: store.items.length };
  }));

  ipcMain.handle('streams:import-file', safe(async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePaths[0]) return { canceled: true };
    const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    const list = Array.isArray(data) ? data : data.streams;
    if (!Array.isArray(list)) throw new Error('Dosyada "streams" listesi yok');
    return store.merge(list);
  }));

  ipcMain.on('log', (_e, event, data) => {
    if (verbose) console.log('[renderer]', event, data === undefined ? '' : JSON.stringify(data));
    if (!smokeArg) return;
    if (event === 'error-fatal') { console.log('SMOKE FAIL'); app.exit(1); }
    if (event === 'playing') { console.log('SMOKE OK'); app.exit(0); }
  });
}

// Program eskiden "M3U8 Player" adıyla bu klasörü kullanıyordu
const LEGACY_DIR = path.join(app.getPath('appData'), 'M3U8 Player');

/** Eski adla kaydedilmiş yayınları, token'ı ve kurulum durumunu yeni klasöre bir kez kopyalar. */
function migrateLegacyData() {
  const dir = app.getPath('userData');
  if (smokeArg || profileArg || dir === LEGACY_DIR || fs.existsSync(path.join(dir, 'streams.json'))) return;
  if (!fs.existsSync(path.join(LEGACY_DIR, 'streams.json'))) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['streams.json', 'bridge.json', 'setup.json']) {
    const from = path.join(LEGACY_DIR, f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, f));
  }
  console.log('[migrate] eski veriler taşındı:', LEGACY_DIR, '→', dir);
}

app.whenReady().then(() => {
  try { migrateLegacyData(); } catch (e) { console.error('[migrate]', e.message); }
  store = new Store(path.join(app.getPath('userData'), 'streams.json'));
  protocol.handle(SCHEME, handleStream);
  bridge = new Bridge({
    file: path.join(app.getPath('userData'), 'bridge.json'),
    port: bridgePort,
    version: app.getVersion(),
    onImport: onBridgeImport,
    onClient: onBridgeClient,
  });
  if (!smokeArg) bridge.start();
  extSetup = new ExtensionSetup({
    // Paketli uygulamada eklenti extraResources ile resources/extension altına konur (asar dışında)
    srcDir: app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(__dirname, 'extension'),
    userData: app.getPath('userData'),
    bridgeInfo: () => bridge.info(),
    // Tarayıcı eski adla kurulan kopyayı yüklemeye devam eder: onu da güncel tut
    extraDirs: profileArg ? [] : [path.join(LEGACY_DIR, 'extension')],
  });
  if (smokeArg) extSetup.skip();
  else {
    try { extSetup.refresh(); } catch (e) { console.error('[extension]', e.message); }
  }
  registerIpc();
  if (!verbose) Menu.setApplicationMenu(null);
  createWindow();
});

app.on('window-all-closed', () => app.quit());
