const { app, BrowserWindow, protocol, session } = require('electron');
const { readFileSync } = require('node:fs');
const { resolve, sep } = require('node:path');

const rendererRoot = resolve(process.argv[2]);
app.setPath('userData', resolve(process.argv[3]));
protocol.registerSchemesAsPrivileged([{ scheme: 'lycan', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }]);

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  // Exercise the shipped worklets against the application's actual policy, without joining a room.
  const mainSource = readFileSync(resolve('electron/main.cjs'), 'utf8');
  const policy = mainSource.match(/headers\.set\('Content-Security-Policy', "([^"]+)"\)/)?.[1];
  if (!policy) throw new Error('Application content security policy not found');
  protocol.handle('lycan', (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response(null, { status: 403 });
    if (url.pathname === '/') return new Response('<!doctype html><title>Audio worklet test</title>', {
      headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': policy },
    });
    const file = resolve(rendererRoot, `.${url.pathname}`);
    if (!file.startsWith(rendererRoot + sep) || !file.endsWith('.js')) return new Response(null, { status: 403 });
    return new Response(readFileSync(file), { headers: { 'Content-Type': 'text/javascript' } });
  });
  const window = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  await window.loadURL('lycan://app/');
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
