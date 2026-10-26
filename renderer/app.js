'use strict';
// `api` preload.js'teki contextBridge'den global olarak gelir
const $ = (s) => document.querySelector(s);
const video = $('#video');
const editor = $('#editor');
const form = $('#editorForm');

let streams = [];
let current = null;
let hls = null;
let retries = 0;
let editingId = null;
let toastTimer;
let filter = 'all';
let bridgeState = null;

// ---------- yardımcılar ----------
const TOAST_ICONS = { info: 'i-info', ok: 'i-check', err: 'i-alert', warn: 'i-alert', key: 'i-key', ext: 'i-puzzle' };
const NS = 'http://www.w3.org/2000/svg';

function setStatus(text, cls = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = `status ${cls}`;
  $('#loading').classList.toggle('hidden', !(cls === 'warn' || text === 'Yükleniyor…' || text === 'Kaynak çözülüyor…'));
}
function toast(text, kind = 'info') {
  const el = $('#toast');
  $('#toastText').textContent = text;
  $('#toastIcon').setAttribute('href', `#${TOAST_ICONS[kind] || TOAST_ICONS.info}`);
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'err' ? 5000 : 2800);
}
function icon(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'ic');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}
function host(u) { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } }
/** Yayın için baş harfler + siteye göre sabit renk tonu. */
function paintAvatar(el, s) {
  const words = (s.name || host(s.url)).replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/);
  el.textContent = ((words[0]?.[0] || '?') + (words[1]?.[0] || '')).toLocaleUpperCase('tr');
  let h = 0;
  for (const c of host(s.pageUrl || s.url)) h = (h * 31 + c.charCodeAt(0)) % 360;
  el.style.setProperty('--h', h);
}
// Süreli imza ya da token servisi taşıyan adres
const isTokenized = (u) => /[?&](st|e|exp|expires|token|hdnts|sig|signature)=|[?&]url=https?%3A/i.test(u);
function ago(ts) {
  if (!ts) return 'hiç oynatılmadı';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'az önce';
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 86400) return `${Math.floor(s / 3600)} sa önce`;
  return `${Math.floor(s / 86400)} gün önce`;
}
function showOverlay(msg) { $('#overlayMsg').textContent = msg; $('#overlay').classList.remove('hidden'); $('#loading').classList.add('hidden'); }
function hideOverlay() { $('#overlay').classList.add('hidden'); }

// ---------- liste ----------
async function refresh() {
  const r = await api.list();
  if (r.error) return setStatus(r.error, 'err');
  streams = r;
  renderList();
}

function renderList() {
  const q = $('#search').value.trim().toLocaleLowerCase('tr');
  const ul = $('#list');
  ul.replaceChildren();
  const items = streams.filter((s) => (filter !== 'fav' || s.favorite) && (filter !== 'ext' || s.source === 'extension')
    && (!q || `${s.name} ${s.url} ${s.pageUrl || ''} ${s.notes || ''}`.toLocaleLowerCase('tr').includes(q)));
  $('#listCount').textContent = streams.length ? String(streams.length) : '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'list-empty';
    li.textContent = !streams.length ? 'Henüz yayın yok. Üstteki kutuya bir cURL ya da m3u8 adresi yapıştır.'
      : q ? 'Aramayla eşleşen yayın yok.' : filter === 'fav' ? 'Favori yayın yok. Satırdaki ☆ ile ekleyebilirsin.' : 'Eklentiden gelen yayın yok.';
    ul.append(li);
    return;
  }
  for (const s of items) {
    const li = document.createElement('li');
    const playing = current?.id === s.id;
    li.className = 'item' + (playing ? ' active' : '');
    li.title = s.url;
    li.innerHTML = '<div class="avatar"></div><div class="meta"><div class="name"><span></span></div><div class="sub"><span class="host"></span></div></div>'
      + '<div class="acts"><button class="icon-btn" data-act="fav"></button><button class="icon-btn" data-act="edit" title="Düzenle"></button>'
      + '<button class="icon-btn" data-act="del" title="Sil"></button></div>';
    const av = li.querySelector('.avatar');
    paintAvatar(av, s);
    if (s.source === 'extension') {
      const b = document.createElement('span');
      b.className = 'badge-ext';
      b.title = 'Tarayıcı eklentisinden';
      b.append(icon('i-puzzle'));
      av.append(b);
    }
    const name = li.querySelector('.name');
    name.firstChild.textContent = s.name;
    if (playing && hls) {
      const eq = document.createElement('span');
      eq.className = 'eq' + (video.paused ? ' paused' : '');
      eq.innerHTML = '<i></i><i></i><i></i>';
      name.prepend(eq);
    }
    if (s.favorite) {
      const star = icon('i-star-fill');
      star.classList.add('fav');
      name.append(star);
    }
    if (isTokenized(s.url)) {
      const t = document.createElement('span');
      t.className = 'tag';
      t.textContent = 'TOKEN';
      t.title = 'Süreli imzalı adres ya da token servisi: süresi dolunca otomatik yenilenir';
      name.append(t);
    }
    li.querySelector('.host').textContent = `${host(s.pageUrl || s.url)} · ${ago(s.lastPlayedAt)}`;
    const fav = li.querySelector('[data-act=fav]');
    fav.append(icon(s.favorite ? 'i-star-fill' : 'i-star'));
    fav.title = s.favorite ? 'Favorilerden çıkar' : 'Favorilere ekle';
    if (s.favorite) fav.classList.add('fav-on');
    li.querySelector('[data-act=edit]').append(icon('i-edit'));
    li.querySelector('[data-act=del]').append(icon('i-trash'));
    li.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'edit') openEditor(s);
      else if (act === 'del') removeStream(s);
      else if (act === 'fav') toggleFavorite(s);
      else play(s.id);
    });
    ul.append(li);
  }
}

async function toggleFavorite(s) {
  const r = await api.save({ ...s, favorite: !s.favorite });
  if (r.error) return toast(r.error, 'err');
  await refresh();
}

async function removeStream(s) {
  if (!confirm(`"${s.name}" silinsin mi?`)) return false;
  const r = await api.remove(s.id);
  if (r?.error) { toast(r.error, 'err'); return false; }
  if (current?.id === s.id) stop();
  await refresh();
  toast(`Silindi: ${s.name}`, 'ok');
  return true;
}

// ---------- oynatıcı ----------
function stop() {
  if (hls) { hls.destroy(); hls = null; }
  video.removeAttribute('src');
  video.load();
  current = null;
  renderNow();
  hideOverlay();
  $('#stats').replaceChildren();
  $('#liveBtn').classList.add('hidden');
  $('#empty').classList.remove('hidden');
  setStatus('Hazır');
  renderList();
}

function renderNow() {
  $('#nowName').textContent = current?.name || 'Yayın seçilmedi';
  $('#nowHost').textContent = current ? host(current.pageUrl || current.url) : '';
  const av = $('#nowAvatar');
  if (current) paintAvatar(av, current); else { av.textContent = ''; av.style.removeProperty('--h'); }
}

function stat(label, value, opt = false) {
  const el = document.createElement('span');
  el.className = 'stat' + (opt ? ' opt' : '');
  el.append(`${label} `, Object.assign(document.createElement('b'), { textContent: value }));
  return el;
}

// Çözünürlük, bit hızı, tampon ve canlı gecikmesi
let lastDownload = '';
function updateStats() {
  if (!hls || !current) return;
  const lvl = hls.levels?.[hls.currentLevel];
  const chips = [];
  if (lvl?.height) chips.push(stat('', `${lvl.height}p`));
  if (lvl?.bitrate) chips.push(stat('', `${(lvl.bitrate / 1e6).toFixed(1)} Mbit/s`));
  const b = video.buffered;
  if (b.length) chips.push(stat('tampon', `${Math.max(0, b.end(b.length - 1) - video.currentTime).toFixed(0)} sn`, true));
  if (lastDownload) chips.push(stat('indirme', lastDownload, true));
  $('#stats').replaceChildren(...chips);

  const live = lvl?.details?.live;
  const btn = $('#liveBtn');
  btn.classList.toggle('hidden', !live);
  if (live && hls.liveSyncPosition) {
    const behind = hls.liveSyncPosition - video.currentTime;
    const atEdge = behind < 6;
    btn.classList.toggle('at-edge', atEdge);
    $('#liveText').textContent = atEdge ? 'CANLI' : `CANLI −${Math.round(behind)} sn`;
    btn.title = atEdge ? 'Canlı yayındasın' : 'Canlı noktaya atla';
  }
}
setInterval(updateStats, 1000);

async function play(id) {
  hideOverlay();
  $('#empty').classList.add('hidden');
  setStatus('Kaynak çözülüyor…');
  const r = await api.prepare(id);
  if (r.error) {
    // Önceki yayın arkada çalmaya devam etmesin: hata, seçilen yayına ait
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src');
    video.load();
    $('#stats').replaceChildren();
    $('#liveBtn').classList.add('hidden');
    current = streams.find((s) => s.id === id) || current;
    renderNow();
    renderList();
    $('#empty').classList.add('hidden');
    setStatus('Yayın açılamadı', 'err');
    return showOverlay(r.error);
  }
  current = r.stream;
  renderNow();
  renderList();
  startHls(r.src);
  refresh();
}

function startHls(src) {
  if (hls) hls.destroy();
  retries = 0;
  hideOverlay();
  $('#empty').classList.add('hidden');
  $('#stats').replaceChildren();
  lastDownload = '';
  setStatus('Yükleniyor…');

  hls = new Hls({ liveSyncDurationCount: 3, maxBufferLength: 30, manifestLoadingMaxRetry: 2 });
  hls.loadSource(src);
  hls.attachMedia(video);

  hls.on(Hls.Events.MANIFEST_PARSED, (_, d) => {
    const q = $('#quality');
    q.replaceChildren(new Option('Otomatik', '-1'));
    d.levels.forEach((l, i) => {
      const label = (l.height ? `${l.height}p` : `Seviye ${i + 1}`) + (l.bitrate ? ` · ${Math.round(l.bitrate / 1000)} kbps` : '');
      q.append(new Option(label, String(i)));
    });
    api.log('manifest', { levels: d.levels.length });
    video.play().catch(() => {});
  });
  hls.on(Hls.Events.FRAG_LOADED, (_, d) => {
    retries = 0;
    // Segmentin indirilme hızı (yayının bit hızı değil): bağlantının ne kadar rahat yettiğini gösterir
    const s = d.frag.stats;
    const ms = s.loading.end - s.loading.start;
    lastDownload = ms > 0 ? `${(s.total * 8 / ms / 1000).toFixed(0)} Mbit/s` : '';
  });
  hls.on(Hls.Events.ERROR, (_, d) => {
    api.log('hls-error', { type: d.type, details: d.details, fatal: d.fatal, code: d.response?.code });
    if (!d.fatal) return;
    if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
      setStatus('Medya hatası, kurtarılıyor…', 'warn');
      hls.recoverMediaError();
    } else if (d.type === Hls.ErrorTypes.NETWORK_ERROR && retries++ < 5) {
      setStatus(`Ağ hatası, yeniden deneniyor (${retries}/5)…`, 'warn');
      setTimeout(() => hls?.startLoad(), 1500 * retries);
    } else {
      const code = d.response?.code;
      setStatus(`Hata: ${d.details}${code ? ` (${code})` : ''}`, 'err');
      showOverlay(code === 403 || code === 401
        ? `Sunucu ${code} döndü. Header'lar (Referer/Origin/token) büyük ihtimalle eskidi; tarayıcıdan cURL'ü yeniden kopyalayıp güncelle.`
        : `Yayın açılamadı: ${d.details}${code ? ` (HTTP ${code})` : ''}`);
      api.log('error-fatal', d.details);
    }
  });
}

video.addEventListener('playing', () => { setStatus('Oynatılıyor', 'ok'); hideOverlay(); renderList(); api.log('playing'); });
video.addEventListener('waiting', () => setStatus('Arabelleğe alınıyor…', 'warn'));
video.addEventListener('pause', () => { if (current) { setStatus('Duraklatıldı'); renderList(); } });

api.onTokenRefreshed(({ reason }) => {
  api.log('token-refreshed', reason);
  toast(`Yayın token'ı yenilendi (${reason})`, 'key');
});

api.onUpstreamError((e) => {
  const what = e.status ? `HTTP ${e.status}` : e.message;
  setStatus(`Kaynak: ${what}`, 'err');
});

$('#quality').addEventListener('change', (e) => { if (hls) hls.currentLevel = Number(e.target.value); });
$('#liveBtn').addEventListener('click', () => { if (hls?.liveSyncPosition) video.currentTime = hls.liveSyncPosition; video.play().catch(() => {}); });
$('#stopBtn').addEventListener('click', () => current && stop());
$('#pipBtn').addEventListener('click', async () => {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (current) await video.requestPictureInPicture();
  } catch (e) { toast(e.message, 'err'); }
});
$('#retryBtn').addEventListener('click', () => current && play(current.id));
$('#fixBtn').addEventListener('click', () => current && openEditor(current, true));
$('#editCurrent').addEventListener('click', () => current ? openEditor(current) : toast('Oynatılan yayın yok', 'warn'));

// ---------- hızlı oynat ----------
async function quickPlay() {
  const text = $('#quick').value.trim();
  if (!text) return;
  const r = await api.importCurl(text);
  if (r.error) { toast(r.error, 'err'); return; }
  $('#quick').value = '';
  $('#quick').blur();
  toast(r.created ? `Kaydedildi: ${r.stream.name}` : `Güncellendi: ${r.stream.name}`, 'ok');
  await play(r.stream.id);
}

$('#quickPlay').addEventListener('click', quickPlay);
$('#quick').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); quickPlay(); }
});
// Yapıştırınca doğrudan başlat
$('#quick').addEventListener('paste', () => setTimeout(() => {
  const v = $('#quick').value.trim();
  if (/^curl(\.exe)?\s/i.test(v) || /^https?:\/\/\S+$/i.test(v)) quickPlay();
}, 0));

// ---------- düzenleyici ----------
function headerRow(name = '', value = '') {
  const row = document.createElement('div');
  row.className = 'hrow';
  const n = Object.assign(document.createElement('input'), { value: name, placeholder: 'Ad', spellcheck: false });
  const v = Object.assign(document.createElement('input'), { value, placeholder: 'Değer', spellcheck: false });
  const x = Object.assign(document.createElement('button'), { type: 'button', className: 'icon', textContent: '✕', title: 'Kaldır' });
  x.addEventListener('click', () => { row.remove(); countHeaders(); });
  row.append(n, v, x);
  return row;
}
function countHeaders() { $('#headerCount').textContent = `(${$('#headerRows').children.length})`; }
function setHeaders(list) {
  $('#headerRows').replaceChildren(...list.map((h) => headerRow(h.name, h.value)));
  countHeaders();
}
function readHeaders() {
  return [...$('#headerRows').children]
    .map((r) => ({ name: r.children[0].value.trim(), value: r.children[1].value }))
    .filter((h) => h.name);
}

function openEditor(s = null, focusCurl = false) {
  editingId = s?.id || null;
  $('#editorTitle').textContent = s ? 'Yayını düzenle' : 'Yeni yayın';
  form.name.value = s?.name || '';
  form.url.value = s?.url || '';
  form.curl.value = s?.curl || '';
  form.notes.value = s?.notes || '';
  form.pageUrl.value = s?.pageUrl || '';
  form.favorite.checked = Boolean(s?.favorite);
  setHeaders(s?.headers || []);
  $('#parseMsg').textContent = '';
  $('#delBtn').classList.toggle('hidden', !s);
  $('#curlBox').open = focusCurl || !s;
  editor.showModal();
  if (focusCurl) { form.curl.select(); form.curl.focus(); }
}

async function fillFromCurl() {
  const r = await api.parseCurl(form.curl.value);
  if (r.error) { $('#parseMsg').textContent = `✕ ${r.error}`; return; }
  form.url.value = r.url;
  setHeaders(r.headers);
  $('#parseMsg').textContent = `✓ ${r.headers.length} header alındı`
    + (r.ignored.length ? ` · yok sayılan: ${r.ignored.join(', ')}` : '');
}

async function saveEditor(andPlay) {
  if (form.curl.value.trim() && !form.url.value.trim()) await fillFromCurl();
  if (!form.url.reportValidity()) return;
  const r = await api.save({
    id: editingId || undefined,
    name: form.name.value,
    url: form.url.value.trim(),
    headers: readHeaders(),
    curl: form.curl.value.trim(),
    notes: form.notes.value,
    pageUrl: form.pageUrl.value.trim(),
    favorite: form.favorite.checked,
  });
  if (r.error) { toast(r.error, 'err'); return; }
  editor.close();
  await refresh();
  toast('Kaydedildi', 'ok');
  if (andPlay || current?.id === r.id) await play(r.id); // oynayan yayın düzenlendiyse yeni header'larla yeniden başlat
}

$('#addHeader').addEventListener('click', () => {
  const row = headerRow();
  $('#headerRows').append(row);
  countHeaders();
  row.firstChild.focus();
});
$('#fillFromCurl').addEventListener('click', fillFromCurl);
$('#saveBtn').addEventListener('click', () => saveEditor(false));
$('#savePlayBtn').addEventListener('click', () => saveEditor(true));
$('#cancelBtn').addEventListener('click', () => editor.close());
$('#delBtn').addEventListener('click', async () => {
  const s = streams.find((x) => x.id === editingId);
  if (s && await removeStream(s)) editor.close();
});
form.curl.addEventListener('paste', () => setTimeout(fillFromCurl, 0));

// ---------- kenar çubuğu ----------
$('#search').addEventListener('input', renderList);
$('#newBtn').addEventListener('click', () => openEditor());
$('#filters').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-filter]');
  if (!chip) return;
  filter = chip.dataset.filter;
  for (const c of $('#filters').children) c.classList.toggle('active', c === chip);
  renderList();
});
const moreMenu = $('#moreMenu');
$('#moreBtn').addEventListener('click', (e) => { e.stopPropagation(); moreMenu.classList.toggle('hidden'); });
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) moreMenu.classList.add('hidden'); });
$('#exportBtn').addEventListener('click', async () => {
  moreMenu.classList.add('hidden');
  const r = await api.exportAll();
  if (r.error) toast(r.error, 'err'); else if (!r.canceled) toast(`${r.count} yayın dışa aktarıldı`, 'ok');
});
$('#importBtn').addEventListener('click', async () => {
  moreMenu.classList.add('hidden');
  const r = await api.importFile();
  if (r.error) toast(r.error, 'err');
  else if (!r.canceled) { toast(`${r.added} eklendi, ${r.updated} güncellendi`, 'ok'); refresh(); }
});
for (const b of document.querySelectorAll('.dlg-close')) b.addEventListener('click', () => b.closest('dialog').close());

document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 'l') { e.preventDefault(); $('#quick').focus(); }
  if (e.ctrlKey && k === 'f') { e.preventDefault(); $('#search').focus(); }
  if (e.ctrlKey && k === 'n') { e.preventDefault(); openEditor(); }
  if (e.key === 'Escape') moreMenu.classList.add('hidden');
  // Tek tuş kısayolları yalnızca yazı alanında değilken
  if (e.ctrlKey || e.altKey || e.metaKey || e.target.closest('input, textarea, select, dialog')) return;
  if (k === 'f' && current) { e.preventDefault(); document.fullscreenElement ? document.exitFullscreen() : $('.video-wrap').requestFullscreen(); }
  if (k === 'm') { video.muted = !video.muted; toast(video.muted ? 'Ses kapalı' : 'Ses açık'); }
  if (k === ' ' && current && e.target === document.body) { e.preventDefault(); video.paused ? video.play() : video.pause(); }
});

$('#openPage').addEventListener('click', async () => {
  const r = await api.openExternal(form.pageUrl.value.trim());
  if (r?.error) toast(r.error, 'err');
});

// ---------- Chrome eklentisi köprüsü ----------
function renderBridgeFoot() {
  const b = bridgeState;
  if (!b) return;
  const connected = b.listening && b.client;
  $('#bridgeDot').className = 'dot ' + (!b.listening ? 'off' : connected ? 'on' : 'wait');
  $('#bridgeLabel').textContent = !b.listening ? 'Köprü kapalı' : connected ? 'Eklenti bağlı' : 'Eklenti bekleniyor';
  $('#bridgeSub').textContent = !b.listening ? (b.error || 'başlatılamadı')
    : connected ? `${b.client.name.replace('extension/', 'v')} · ${ago(b.client.at)}` : 'kurmak için tıkla';
  $('#emptyExtBtn').classList.toggle('hidden', Boolean(connected));
  $('#emptyExtOk').classList.toggle('hidden', !connected);
}

async function renderBridge() {
  const b = await api.bridgeInfo();
  if (b.error) return toast(b.error, 'err');
  $('#bridgePort').value = b.port;
  $('#bridgeToken').value = b.token;
  const st = $('#bridgeStatus');
  st.textContent = b.listening ? `● 127.0.0.1:${b.port} dinleniyor` : `● Köprü kapalı: ${b.error || 'başlatılamadı'}`;
  st.className = b.listening ? 'ok' : 'err';
  bridgeState = b;
  renderBridgeFoot();
  $('#bridgeClient').textContent = b.client ? `Son eklenti bağlantısı: ${b.client.name} · ${ago(b.client.at)}` : 'Eklenti henüz bağlanmadı.';
}
$('#bridgeBtn').addEventListener('click', async () => { await renderBridge(); $('#bridgeDlg').showModal(); });
$('#copyToken').addEventListener('click', async () => { await api.copy($('#bridgeToken').value); toast('Token kopyalandı', 'ok'); });
$('#emptyExtBtn').addEventListener('click', () => openExtSetup());
$('#regenToken').addEventListener('click', async () => {
  if (!confirm('Token yenilensin mi? Uygulamadan kurulan eklenti yenisini otomatik alır; elle kurduysan eklentiye yeniden girmen gerekir.')) return;
  await api.bridgeRegenerate();
  await renderBridge();
  toast('Yeni token oluşturuldu', 'key');
});

// ---------- tarayıcı eklentisi kurulumu (ilk açılışta otomatik) ----------
const extDlg = $('#extDlg');
let extBrowserId = null;

function showExtStep(step) {
  const pick = step === 'pick';
  $('#extPick').classList.toggle('hidden', !pick);
  $('#extSteps').classList.toggle('hidden', pick);
  $('#extInstall').classList.toggle('hidden', !pick);
  $('#extBack').classList.toggle('hidden', pick);
  $('#extReopen').classList.toggle('hidden', pick);
  $('#extDone').classList.add('hidden');
  $('#extLater').classList.remove('hidden');
}

function setExtWait(connectedAs) {
  const w = $('#extWait');
  w.textContent = connectedAs
    ? `✓ Eklenti bağlandı (${connectedAs}). Artık sayfalardaki yayınlar otomatik gelecek.`
    : '● Eklentinin bağlanması bekleniyor… (port ve token otomatik ayarlanır)';
  w.className = connectedAs ? 'ok' : 'warn';
  $('#extDone').classList.toggle('hidden', !connectedAs);
  $('#extLater').classList.toggle('hidden', Boolean(connectedAs));
}

async function openExtSetup() {
  const s = await api.extStatus();
  if (s.error) return toast(s.error, 'err');
  const box = $('#extBrowsers');
  box.replaceChildren();
  const preferred = s.browsers.find((b) => b.id === s.state.browser) || s.browsers.find((b) => b.id === s.defaultId) || s.browsers[0];
  for (const b of s.browsers) {
    const label = document.createElement('label');
    label.innerHTML = '<input type="radio" name="extBrowser"><span></span><small></small>';
    label.querySelector('input').value = b.id;
    label.querySelector('input').checked = b === preferred;
    label.querySelector('span').textContent = b.name;
    label.querySelector('small').textContent = b.id === s.defaultId ? 'varsayılan' : '';
    box.append(label);
  }
  $('#extNone').classList.toggle('hidden', s.browsers.length > 0);
  $('#extInstall').disabled = !s.browsers.length;
  showExtStep('pick');
  if (!extDlg.open) extDlg.showModal();
}

async function installExt(browserId) {
  const r = await api.extInstall(browserId);
  if (r.error) return toast(`Kurulum başlatılamadı: ${r.error}`, 'err');
  extBrowserId = browserId;
  $('#extBrowserName').textContent = r.browser.name;
  $('#extDir').value = r.dir;
  showExtStep('steps');
  setExtWait(null);
}

$('#extInstall').addEventListener('click', () => {
  const id = extDlg.querySelector('input[name=extBrowser]:checked')?.value;
  if (id) installExt(id);
});
$('#extReopen').addEventListener('click', () => installExt(extBrowserId));
$('#extBack').addEventListener('click', () => showExtStep('pick'));
$('#extCopy').addEventListener('click', async () => { await api.copy($('#extDir').value); toast('Klasör yolu kopyalandı', 'ok'); });
$('#extReveal').addEventListener('click', () => api.extReveal());
$('#extLater').addEventListener('click', async () => {
  await api.extSkip();
  extDlg.close();
  toast('Eklentiyi daha sonra sol alttaki eklenti düğmesinden kurabilirsin');
});
$('#openExtSetup').addEventListener('click', () => { $('#bridgeDlg').close(); openExtSetup(); });

api.onBridgeClient((client) => {
  if (!client.name.startsWith('extension/')) return;
  if (extDlg.open && !$('#extSteps').classList.contains('hidden')) setExtWait(client.name);
  const firstContact = !bridgeState?.client;
  renderBridge();
  if (firstContact) toast('Tarayıcı eklentisi bağlandı', 'ext');
});

api.onBridgeImport(async ({ stream, created, play: autoPlay }) => {
  await refresh();
  toast(`${created ? 'Eklentiden eklendi' : 'Eklentiden güncellendi'}: ${stream.name}`, 'ext');
  if (autoPlay) await play(stream.id);
});

api.onSmoke((text) => { $('#quick').value = text; quickPlay(); });
setTimeout(renderBridge, 500);
setInterval(renderBridge, 30000); // "x dk önce" ve bağlantı durumu
api.extStatus().then((s) => { if (s.needsSetup) openExtSetup(); });
setInterval(renderList, 60000);
renderNow(); // "x dk önce" etiketlerini tazele
refresh();
