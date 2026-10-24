const { app, safeStorage } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

// 仅供无界面的加密迁移验证；不加载业务入口、房间、设备或网络。
const profile = resolve(app.commandLine.getSwitchValue('user-data-dir'));
const mode = process.argv.at(-1);
const fixture = 'controlled-runtime-migration';
app.disableHardwareAcceleration();
for (const name of ['userData', 'sessionData']) app.setPath(name, profile);
mkdirSync(join(profile, 'crashDumps'), { recursive: true });
app.setPath('crashDumps', join(profile, 'crashDumps'));
app.setAppLogsPath(join(profile, 'logs'));
const timer = setTimeout(() => app.exit(2), 10000);
app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('encryptionUnavailable');
  if (mode === 'seed') {
    writeFileSync(join(profile, 'session.bin'), safeStorage.encryptString(fixture));
    console.log(JSON.stringify({ seeded: true }));
  } else if (mode === 'check') {
    const plaintext = safeStorage.decryptString(readFileSync(join(profile, 'session.bin')));
    console.log(JSON.stringify({ decrypted: true, fixtureMatches: plaintext === fixture }));
  } else throw new Error('invalidProbeMode');
  clearTimeout(timer);
  app.quit();
}).catch(() => {
  console.log(JSON.stringify({ decrypted: false }));
  app.exit(1);
});
