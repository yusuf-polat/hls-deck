'use strict';
// assets/icon.svg'den uygulama, kurulum ve eklenti ikonlarını; README için banner'ı üretir.
// Ek bağımlılık yok, SVG'yi Electron'un kendi Chromium'u çizer:
//   npx electron scripts/render-assets.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const ICON_SVG = fs.readFileSync(path.join(ROOT, 'assets', 'icon.svg'), 'utf8');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const EXT_SIZES = [16, 32, 48, 128];

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // her çizimde pencere kapanıyor; uygulama erken çıkmasın
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function render(html, width, height) {
  const win = new BrowserWindow({
    width, height, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    useContentSize: true, webPreferences: { offscreen: true },
  });
  // data: URL'leri ardışık yüklemede ERR_FAILED verebiliyor; geçici dosya güvenilir
  const file = path.join(os.tmpdir(), `hlsdeck-render-${process.pid}-${width}x${height}.html`);
  fs.writeFileSync(file, html);
  await win.loadFile(file);
  fs.rmSync(file, { force: true });
  await new Promise((r) => setTimeout(r, 300)); // font ve filtrelerin çizilmesi
  let img = await win.webContents.capturePage();
  if (img.getSize().width !== width) img = img.resize({ width, height, quality: 'best' });
  win.destroy();
  return img.toPNG();
}

const page = (body, w, h, bg = 'transparent') => `<!doctype html><html><head><style>
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${bg}}
  svg{display:block}</style></head><body>${body}</body></html>`;

const iconHtml = (size) => page(ICON_SVG.replace('width="1024" height="1024"', `width="${size}" height="${size}"`), size, size);

/** PNG gömülü .ico (Windows Vista+ ve electron-builder bunu kabul eder). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

function bannerHtml(dark) {
  const fg = dark ? '#eef0f6' : '#0f1222';
  const sub = dark ? '#9aa3b8' : '#4b5470';
  const bg = dark
    ? 'radial-gradient(900px 420px at 20% 0%, rgba(91,124,255,.28), transparent 60%), radial-gradient(700px 400px at 100% 100%, rgba(123,77,255,.22), transparent 60%), #0b0d14'
    : 'radial-gradient(900px 420px at 20% 0%, rgba(91,124,255,.16), transparent 60%), radial-gradient(700px 400px at 100% 100%, rgba(123,77,255,.14), transparent 60%), #f7f8fc';
  const icon = ICON_SVG.replace('width="1024" height="1024"', 'width="220" height="220"');
  return page(`<div style="height:100%;display:flex;align-items:center;justify-content:center;gap:48px;background:${bg};
      font-family:'Segoe UI Variable Display','Segoe UI',system-ui,sans-serif">
    ${icon}
    <div>
      <div style="font-size:104px;font-weight:700;letter-spacing:-2px;color:${fg};line-height:1">HLS Deck</div>
      <div style="font-size:30px;color:${sub};margin-top:16px;max-width:640px;line-height:1.35">
        Header'ları korunan HLS yayınları için masaüstü oynatıcı ve tarayıcı köprüsü</div>
    </div></div>`, 1280, 400);
}

app.whenReady().then(async () => {
  const pngs = [];
  for (const size of ICO_SIZES) pngs.push({ size, data: await render(iconHtml(size), size, size) });
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico(pngs));

  const big = await render(iconHtml(512), 512, 512);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), big);
  fs.writeFileSync(path.join(ROOT, 'assets', 'icon-512.png'), big);
  fs.writeFileSync(path.join(ROOT, 'renderer', 'icon.png'), await render(iconHtml(256), 256, 256));

  for (const size of EXT_SIZES) {
    fs.writeFileSync(path.join(ROOT, 'extension', 'icons', `${size}.png`), pngs.find((p) => p.size === size)?.data
      || await render(iconHtml(size), size, size));
  }

  fs.writeFileSync(path.join(ROOT, 'assets', 'banner-dark.png'), await render(bannerHtml(true), 1280, 400));
  fs.writeFileSync(path.join(ROOT, 'assets', 'banner-light.png'), await render(bannerHtml(false), 1280, 400));
  console.log('ikonlar ve banner üretildi');
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
