'use strict';
const $ = (s) => document.querySelector(s);
let tabId = null;

async function bg(msg) {
  const r = await chrome.runtime.sendMessage(msg);
  if (r?.error) throw new Error(r.error);
  return r?.result;
}

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s} sn önce` : `${Math.floor(s / 60)} dk önce`;
}

function toCurl(item) {
  const q = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
  return [`curl ${q(item.url)}`, ...item.headers.map((h) => `  -H ${q(`${h.name}: ${h.value}`)}`)].join(' \\\n');
}

async function render() {
  const st = await bg({ type: 'list', tabId });
  const ul = $('#list');
  ul.replaceChildren();
  $('#empty').classList.toggle('hidden', st.items.length > 0);
  $('#count').textContent = `Bu sekmede yakalanan m3u8 (${st.items.length})`;

  for (const item of st.items) {
    const li = document.createElement('li');
    li.innerHTML = '<div class="url"></div><div class="meta"></div><div class="msg"></div>'
      + '<div class="acts"><button data-act="send">Gönder</button><button data-act="play" class="primary">Gönder ve oynat</button>'
      + '<span class="spacer"></span><button data-act="curl" title="cURL olarak kopyala">cURL</button></div>';
    li.querySelector('.url').textContent = item.url;
    const ref = item.headers.find((h) => /^referer$/i.test(h.name))?.value;
    let refHost = '';
    try { refHost = ref ? ` · referer: ${new URL(ref).host}` : ''; } catch { refHost = ` · referer: ${ref}`; }
    const via = item.resolver ? ` · token servisi: ${new URL(item.resolver.url).host}` : '';
    li.querySelector('.meta').textContent = `${item.headers.length} header · ${ago(item.firstSeen)}${refHost}${via}`;
    const msg = li.querySelector('.msg');
    msg.textContent = item.message;
    msg.className = `msg ${item.status}`;
    li.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'curl') {
        await navigator.clipboard.writeText(toCurl(item));
        e.target.textContent = 'Kopyalandı';
        return;
      }
      e.target.disabled = true;
      try { await bg({ type: 'send', tabId, url: item.url, play: act === 'play' }); }
      catch (err) { msg.textContent = err.message; msg.className = 'msg error'; }
      await render();
    });
    ul.append(li);
  }
}

async function checkConn(cfg) {
  const pill = $('#conn');
  const r = await bg({ type: 'ping', cfg });
  pill.textContent = r.ok ? `bağlı · v${r.version}` : 'bağlı değil';
  pill.className = `pill ${r.ok ? 'ok' : 'err'}`;
  pill.title = r.ok ? '' : r.error;
  return r;
}

async function init() {
  [{ id: tabId }] = await chrome.tabs.query({ active: true, currentWindow: true });
  const cfg = await bg({ type: 'cfg' }); // background uygulamanın bootstrap.json'unu da işler
  $('#port').value = cfg.port;
  $('#token').value = cfg.token;
  $('#autoSend').checked = cfg.autoSend;
  $('#playOnSend').checked = cfg.playOnSend;
  if (!cfg.token) $('#settings').classList.remove('hidden');

  $('#settingsBtn').addEventListener('click', () => $('#settings').classList.toggle('hidden'));
  $('#saveCfg').addEventListener('click', async () => {
    const next = {
      port: Number($('#port').value) || 17865,
      token: $('#token').value.trim(),
      autoSend: $('#autoSend').checked,
      playOnSend: $('#playOnSend').checked,
    };
    await chrome.storage.local.set(next);
    const r = await checkConn(next);
    $('#cfgMsg').textContent = r.ok ? '✓ Kaydedildi, uygulamaya bağlandı' : `✕ ${r.error}`;
    $('#cfgMsg').className = r.ok ? 'ok' : 'err';
  });
  $('#clearBtn').addEventListener('click', async () => { await bg({ type: 'clear', tabId }); render(); });

  render();
  checkConn(cfg);
}

init().catch((e) => { document.body.append(Object.assign(document.createElement('p'), { textContent: e.message, className: 'muted' })); });
