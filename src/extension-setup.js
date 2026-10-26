'use strict';
// Tarayıcı eklentisinin ilk açılışta kurulumu: eklentiyi kullanıcı klasörüne kopyalar, köprü port/token'ını
// içine bootstrap.json olarak yazar ve seçilen tarayıcının eklenti sayfasını açar.
// Chrome/Edge, Windows'ta mağaza dışı eklentilerin sessizce kurulmasına izin vermez (yalnızca yönetilen
// cihazlarda politika ile); bu yüzden "Paketlenmemiş öğe yükle" adımı kullanıcıda kalır.
const fs = require('node:fs');
const path = require('node:path');
const browsers = require('./browsers');

/** Eklenti dosyalarını destDir'e kopyalar, bootstrap.json yazar; manifest sürümünü döner. */
function deployExtension(srcDir, destDir, { port, token }) {
  const { version } = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
  fs.cpSync(srcDir, destDir, { recursive: true, force: true });
  writeBootstrap(destDir, { port, token });
  return version;
}

function writeBootstrap(dir, { port, token }) {
  const file = path.join(dir, 'bootstrap.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ port, token }, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

class ExtensionSetup {
  /**
   * @param {{srcDir: string, userData: string, bridgeInfo: () => {port: number, token: string}, browserApi?: object,
   *          extraDirs?: string[]}} opts  extraDirs: tarayıcının yüklediği başka kopyalar (ör. eski adla kurulan)
   */
  constructor({ srcDir, userData, bridgeInfo, browserApi = browsers, extraDirs = [] }) {
    this.srcDir = srcDir;
    this.extraDirs = extraDirs;
    this.dir = path.join(userData, 'extension');
    this.file = path.join(userData, 'setup.json');
    this.bridgeInfo = bridgeInfo;
    this.browsers = browserApi;
    this.state = this.#load();
  }

  #load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
  }

  #save(patch) {
    Object.assign(this.state, patch);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    return this.state;
  }

  /** Eklenti hiç bağlanmadıysa ve kullanıcı "daha sonra" demediyse ilk açılış sihirbazı gösterilir. */
  get needsSetup() { return !this.state.connectedAt && !this.state.skipped; }

  async status() {
    return {
      needsSetup: this.needsSetup,
      state: this.state,
      browsers: this.browsers.detect(),
      defaultId: await this.browsers.defaultBrowserId(),
      dir: this.dir,
    };
  }

  async install(browserId) {
    const b = this.browsers.detect().find((x) => x.id === browserId);
    if (!b) throw new Error('Seçilen tarayıcı bulunamadı');
    const version = deployExtension(this.srcDir, this.dir, this.bridgeInfo());
    this.#save({ browser: b.id, deployedVersion: version, skipped: false });
    await this.browsers.openExtensionsPage(b);
    return { dir: this.dir, browser: b };
  }

  /** Kurulmuş kopyayı güncel tutar: uygulama güncellemesinde dosyalar, token yenilenince bootstrap.json. */
  refresh() {
    for (const d of this.extraDirs) {
      if (d !== this.dir && fs.existsSync(path.join(d, 'manifest.json'))) deployExtension(this.srcDir, d, this.bridgeInfo());
    }
    if (!this.state.deployedVersion || !fs.existsSync(this.dir)) return false;
    const version = deployExtension(this.srcDir, this.dir, this.bridgeInfo());
    if (version !== this.state.deployedVersion) this.#save({ deployedVersion: version });
    return true;
  }

  markConnected(client) {
    if (this.state.connectedAt && this.state.client === client) return this.state;
    return this.#save({ connectedAt: Date.now(), client });
  }

  skip() { return this.#save({ skipped: true }); }
}

module.exports = { ExtensionSetup, deployExtension, writeBootstrap };
