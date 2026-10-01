const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit', windowsHide: true,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow } = require('electron');
  app.setName('Easel icon renderer');
  app.setPath('userData', path.join(os.tmpdir(), 'easel-icon-renderer'));

  app.whenReady().then(async () => {
    const source = path.resolve(process.argv[2] || path.join(__dirname, '..', 'build', 'icon.svg'));
    const output = path.resolve(process.argv[3] || path.join(__dirname, '..', 'build', 'icon.png'));
    const url = 'data:image/svg+xml;base64,' + fs.readFileSync(source).toString('base64');
    const window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await window.loadURL('data:text/html;charset=utf-8,<meta charset="utf-8">');
      const png = await window.webContents.executeJavaScript(`(async () => {
        const image = new Image();
        image.src = ${JSON.stringify(url)};
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1024;
        canvas.getContext('2d').drawImage(image, 0, 0, 1024, 1024);
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, Buffer.from(png, 'base64'));
      console.log('Rendered app icon from ' + source);
    } finally {
      window.destroy();
    }
    app.quit();
  }).catch(error => { console.error(error.message); app.exit(1); });
}
