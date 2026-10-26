'use strict';
// extension/ klasörünü dist/HLS-Deck-Extension-<sürüm>.zip olarak paketler (bağımlılıksız zip yazıcı).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'extension');
const { version } = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const OUT = path.join(ROOT, 'dist', `HLS-Deck-Extension-${version}.zip`);

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// Uygulamanın kurulumda yazdığı dosya pakete girmesin
const files = walk(SRC).filter((f) => path.basename(f) !== 'bootstrap.json').sort();
const local = [];
const central = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(path.relative(SRC, file).split(path.sep).join('/'));
  const data = fs.readFileSync(file);
  const packed = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
  head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(packed.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28);
  cd.writeUInt32LE(offset, 42);
  local.push(head, name, packed);
  central.push(cd, name);
  offset += head.length + name.length + packed.length;
}
const cdBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([...local, cdBuf, end]));
console.log(`${files.length} dosya → ${path.relative(ROOT, OUT)}`);
