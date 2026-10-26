'use strict';
// Chrome/Firefox "Copy as cURL" (bash ve cmd) çıktısını ayrıştırır.

const VALUE_OPTS = new Set([
  '-H', '--header', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '--url',
  '-X', '--request', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii',
  '--data-urlencode', '-u', '--user', '-x', '--proxy', '-o', '--output', '-m', '--max-time',
  '--connect-timeout', '-F', '--form', '--resolve', '-w', '--write-out', '--cacert', '--cert',
  '--key', '-r', '--range', '--retry',
]);

const ANSI_C = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', 0: '\0' };

function tokenize(src) {
  const out = [];
  let cur = null;
  let i = 0;
  const push = () => { if (cur !== null) { out.push(cur); cur = null; } };

  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { push(); i++; continue; }
    if (cur === null) cur = '';

    if (c === '\\') {
      // Satır devamı: "\<newline>"
      const n = src[i + 1];
      const skip = n === '\n' ? 2 : n === '\r' && src[i + 2] === '\n' ? 3 : 0;
      if (skip) { i += skip; if (cur === '') cur = null; continue; }
      if (n !== undefined) cur += n;
      i += 2;
      continue;
    }
    if (c === '$' && src[i + 1] === "'") {
      i += 2;
      while (i < src.length && src[i] !== "'") {
        if (src[i] !== '\\') { cur += src[i++]; continue; }
        const n = src[i + 1];
        const hex = n === 'x' ? /^[0-9a-fA-F]{1,2}/.exec(src.slice(i + 2))
          : n === 'u' ? /^[0-9a-fA-F]{4}/.exec(src.slice(i + 2)) : null;
        if (hex) { cur += String.fromCharCode(parseInt(hex[0], 16)); i += 2 + hex[0].length; continue; }
        cur += n in ANSI_C ? ANSI_C[n] : '\\' + n;
        i += 2;
      }
      if (i >= src.length) throw new Error("Kapanmamış $'...' tırnağı");
      i++;
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new Error('Kapanmamış tek tırnak');
      cur += src.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && '"\\$`\n'.includes(src[i + 1])) {
          if (src[i + 1] !== '\n') cur += src[i + 1];
          i += 2;
        } else {
          cur += src[i++];
        }
      }
      if (i >= src.length) throw new Error('Kapanmamış çift tırnak');
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  push();
  return out;
}

/**
 * @returns {{url: string, method: string, headers: {name: string, value: string}[], ignored: string[]}}
 */
function parseCurl(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new Error('Boş girdi');
  if (/^https?:\/\/\S+$/i.test(s)) return { url: s, method: 'GET', headers: [], ignored: [] };

  // Chrome "Copy as cURL (cmd)": ^" kaçışları ve satır sonunda ^
  if (/(^|\s)\^"/.test(s) || /\^\r?\n/.test(s)) s = s.replace(/\^([\s\S])/g, '$1');

  const t = tokenize(s);
  if (!t.length || !/^curl(\.exe)?$/i.test(t[0])) throw new Error('Girdi "curl" ile başlamalı ya da bir http(s) URL olmalı');

  let url = null;
  let method = 'GET';
  const headers = [];
  const ignored = [];
  const setHeader = (name, value) => {
    name = name.trim();
    const idx = headers.findIndex((h) => h.name.toLowerCase() === name.toLowerCase());
    if (idx >= 0) headers[idx] = { name, value };
    else headers.push({ name, value });
  };

  for (let i = 1; i < t.length; i++) {
    let a = t[i];
    let v;
    if (a.startsWith('--') && a.includes('=')) {
      v = a.slice(a.indexOf('=') + 1);
      a = a.slice(0, a.indexOf('='));
    } else if (/^-[A-Za-z]./.test(a) && VALUE_OPTS.has(a.slice(0, 2))) {
      v = a.slice(2);
      a = a.slice(0, 2);
    }
    if (VALUE_OPTS.has(a) && v === undefined) {
      v = t[++i];
      if (v === undefined) throw new Error(`${a} için değer eksik`);
    }

    switch (a) {
      case '-H': case '--header': {
        const c = v.indexOf(':');
        if (c <= 0) { ignored.push(`${a} ${v}`); break; }
        setHeader(v.slice(0, c), v.slice(c + 1).trim());
        break;
      }
      case '-A': case '--user-agent': setHeader('User-Agent', v); break;
      case '-e': case '--referer': setHeader('Referer', v); break;
      case '-b': case '--cookie': setHeader('Cookie', v); break;
      case '--url': url = v; break;
      case '-X': case '--request': method = v.toUpperCase(); break;
      default:
        if (!a.startsWith('-') && !url) url = a;
        else ignored.push(v === undefined ? a : `${a} ${v}`);
    }
  }

  if (!url) throw new Error('cURL içinde URL bulunamadı');
  if (!/^https?:\/\//i.test(url)) throw new Error(`Desteklenmeyen URL: ${url}`);
  return { url, method, headers, ignored };
}

function autoName(url, headers = []) {
  try {
    const u = new URL(url);
    const ref = headers.find((h) => /^(referer|origin)$/i.test(h.name));
    let site = u.host;
    if (ref) { try { site = new URL(ref.value).host; } catch { /* yoksay */ } }
    const tail = u.pathname.split('/').filter(Boolean).slice(-2).join('/').replace(/\.m3u8$/i, '');
    return tail ? `${site} · ${tail}` : site;
  } catch {
    return url;
  }
}

/** Kayıtta gösterilmek üzere bash uyumlu cURL komutu üretir (parseCurl ile geri ayrıştırılabilir). */
function toCurl(url, headers = []) {
  const q = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
  return [`curl ${q(url)}`, ...headers.map((h) => `  -H ${q(`${h.name}: ${h.value}`)}`)].join(' \\\n');
}

module.exports = { parseCurl, tokenize, autoName, toCurl };
