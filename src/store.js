'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FIELDS = ['name', 'url', 'headers', 'curl', 'notes', 'favorite', 'pageUrl', 'source'];

class Store {
  constructor(file) {
    this.file = file;
    this.items = this.#load();
  }

  #load() {
    if (!fs.existsSync(this.file)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(data.streams) ? data.streams : [];
    } catch (e) {
      // Bozuk dosyayı ezmeden kenara al
      const bak = `${this.file}.bozuk-${Date.now()}`;
      fs.renameSync(this.file, bak);
      console.error(`streams.json okunamadı (${e.message}), yedeklendi: ${bak}`);
      return [];
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, streams: this.items }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list() {
    const ts = (s) => s.lastPlayedAt || s.updatedAt || 0;
    return [...this.items].sort((a, b) => (b.favorite - a.favorite) || ts(b) - ts(a));
  }

  get(id) { return this.items.find((s) => s.id === id) || null; }

  findByUrl(url) { return this.items.find((s) => s.url === url) || null; }

  upsert(input) {
    const now = Date.now();
    const clean = {};
    for (const k of FIELDS) if (k in input) clean[k] = input[k];
    if (clean.headers) {
      clean.headers = clean.headers
        .map((h) => ({ name: String(h.name || '').trim(), value: String(h.value ?? '') }))
        .filter((h) => h.name);
    }
    if ('favorite' in clean) clean.favorite = Boolean(clean.favorite);

    const existing = input.id && this.get(input.id);
    if (existing) {
      Object.assign(existing, clean, { updatedAt: now });
      this.#save();
      return existing;
    }
    const item = {
      id: crypto.randomUUID(), name: '', url: '', headers: [], curl: '', notes: '', favorite: false, pageUrl: '', source: 'manual',
      ...clean, createdAt: now, updatedAt: now, lastPlayedAt: null, playCount: 0,
    };
    this.items.push(item);
    this.#save();
    return item;
  }

  remove(id) {
    const n = this.items.length;
    this.items = this.items.filter((s) => s.id !== id);
    if (this.items.length !== n) this.#save();
    return this.items.length !== n;
  }

  markPlayed(id) {
    const s = this.get(id);
    if (!s) return null;
    s.lastPlayedAt = Date.now();
    s.playCount = (s.playCount || 0) + 1;
    this.#save();
    return s;
  }

  /** İçe aktarım: aynı URL varsa günceller, yoksa ekler. */
  merge(list) {
    let added = 0, updated = 0;
    for (const s of list) {
      if (!s || !s.url) continue;
      const ex = this.findByUrl(s.url);
      if (ex) { this.upsert({ ...s, id: ex.id }); updated++; }
      else { this.upsert({ ...s, id: undefined }); added++; }
    }
    return { added, updated };
  }
}

module.exports = { Store };
