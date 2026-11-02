import { app, BrowserWindow, Menu, safeStorage, session, shell } from 'electron';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp, FileSecrets, localKeyCipher, startGateway, type Cipher, type Gateway } from '@zhongshu/server';

// 桌面外壳：启动本地网关，开一个安全设置的窗口指向它。窗口里不给任何 Node 能力。

const here = dirname(fileURLToPath(import.meta.url));

/** 系统钥匙串（macOS Keychain / Windows DPAPI / Linux Secret Service）加密密钥；不可用时退回本地密钥文件 */
function systemCipher(fallbackKeyFile: string): Cipher {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (data) => safeStorage.decryptString(Buffer.from(data, 'base64')),
    };
  }
  return localKeyCipher(fallbackKeyFile);
}

function webDir(): string | undefined {
  const candidates = [join(process.resourcesPath ?? '', 'web'), join(here, '../../web/dist')];
  return candidates.find((p) => existsSync(join(p, 'index.html')));
}

let gw: Gateway | undefined;
let core: ReturnType<typeof createApp> | undefined;

async function boot() {
  const dataDir = app.getPath('userData');
  core = createApp({ dataDir, secrets: new FileSecrets(join(dataDir, 'secrets.json'), systemCipher(join(dataDir, 'secret.key'))) });
  const staticDir = webDir();
  gw = await startGateway(core, staticDir ? { staticDir } : {});

  // 网页不需要摄像头、麦克风、通知等任何权限
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: '中枢',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  // 只能停留在本地网关的页面；外部链接用系统浏览器打开
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(gw!.url)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  await win.loadURL(gw.openUrl);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });
  app.whenReady().then(async () => {
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    await boot();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && gw) {
        const w = new BrowserWindow({ width: 1360, height: 880, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
        void w.loadURL(gw.openUrl);
      }
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    core?.close();
    void gw?.close();
  });
}
