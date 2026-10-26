'use strict';
// Chrome eklentisinden gelen m3u8 kayıtlarını alan yerel HTTP köprüsü (yalnızca 127.0.0.1).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_PORT = 17865;
const MAX_BODY = 256 * 1024;
const MAX_HEADERS = 100;
const ALLOWED_ORIGIN = /^(chrome|moz)-extension:\/\//;

class Bridge {
  /**
   * @param {{file: string, port?: number, version: string, onImport: (p: object) => object,
   *          onClient?: (c: {name: string, at: number}) => void}} opts
   */
  constructor({ file, port = DEFAULT_PORT, version, onImport, onClient }) {
    this.file = file;
    this.port = port;
    this.version = version;
    this.onImport = onImport;
    this.onClient = onClient;
    this.client = null; // son doğrulanmış istemci (eklenti), kurulum sihirbazı bağlantıyı buradan anlar
    this.server = null;
    this.listening = false;
    this.error = null;
    this.token = this.#loadToken();
  }

  #loadToken() {
    try {
      const { token } = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (/^[0-9a-f]{32}$/.test(token)) return token;
    } catch { /* ilk çalıştırma */ }
    return this.#writeToken(crypto.randomBytes(16).toString('hex'));
  }

  #writeToken(token) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ token }, null, 2));
    return token;
  }

  regenerate() {
    this.token = this.#writeToken(crypto.randomBytes(16).toString('hex'));
    return this.info();
  }

  info() {
    return { port: this.port, token: this.token, listening: this.listening, error: this.error, client: this.client };
  }

  start() {
    this.server = http.createServer((req, res) => this.#handle(req, res).catch((e) => {
      if (!res.headersSent) send(res, 500, { error: e.message });
    }));
    this.server.on('error', (e) => {
      this.listening = false;
      this.error = e.code === 'EADDRINUSE' ? `Port ${this.port} kullanımda (uygulama zaten açık olabilir)` : e.message;
      console.error('[bridge]', this.error);
    });
    this.server.listen(this.port, '127.0.0.1', () => {
      this.listening = true;
      this.error = null;
    });
  }

  stop() { this.server?.close(); }

  #authorized(req) {
    const got = Buffer.from(String(req.headers['x-m3u8-token'] || ''));
    const want = Buffer.from(this.token);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  async #handle(req, res) {
    // Web sayfalarından gelen istekleri (CSRF) ve DNS rebinding'i reddet
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGIN.test(origin)) return send(res, 403, { error: 'origin reddedildi' });
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, { error: 'host reddedildi' });
    if (!this.#authorized(req)) return send(res, 401, { error: 'geçersiz token' });
    const client = String(req.headers['x-m3u8-client'] || '').slice(0, 64);
    if (client) {
      this.client = { name: client, at: Date.now() };
      this.onClient?.(this.client);
    }

    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && pathname === '/ping') {
      return send(res, 200, { ok: true, app: 'HLS Deck', version: this.version });
    }
    if (req.method === 'POST' && pathname === '/import') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: e.message }); }
      const err = validate(body);
      if (err) return send(res, 400, { error: err });
      const r = await this.onImport({
        url: body.url,
        headers: body.headers.map((h) => ({ name: h.name, value: h.value })),
        pageUrl: typeof body.pageUrl === 'string' ? body.pageUrl : '',
        pageTitle: typeof body.pageTitle === 'string' ? body.pageTitle : '',
        play: body.play === true,
      });
      return send(res, 200, { ok: true, created: r.created, stream: { id: r.stream.id, name: r.stream.name } });
    }
    return send(res, 404, { error: 'bulunamadı' });
  }
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('gövde çok büyük')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validate(b) {
  if (!b || typeof b !== 'object') return 'JSON nesnesi bekleniyor';
  if (typeof b.url !== 'string' || !/^https?:\/\//i.test(b.url)) return 'url http(s) olmalı';
  if (!Array.isArray(b.headers) || b.headers.length > MAX_HEADERS) return 'headers dizi olmalı';
  if (!b.headers.every((h) => h && typeof h.name === 'string' && typeof h.value === 'string')) return 'header {name, value} metin olmalı';
  return null;
}

module.exports = { Bridge, DEFAULT_PORT };
