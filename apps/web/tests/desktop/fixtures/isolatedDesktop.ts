import { _electron as electron } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export async function launchIsolatedDesktop(directory: string, apiUrl: string, link?: string) {
  mkdirSync(directory, { recursive: true });
  const entry = resolve(directory, 'entry.cjs');
  // 只在测试进程禁止显示和抢焦点；生产主进程、preload 与渲染代码照常加载。
  writeFileSync(entry, `const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.focus = function () {};
require(${JSON.stringify(resolve('electron/main.cjs'))});
`);
  const args = [entry, '--user-data-dir=' + resolve(directory, 'profile')];
  const env: Record<string, string> = { LYCANSYNC_API_URL: apiUrl };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'LYCANSYNC_API_URL') env[key] = value;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.LYCANSYNC_DEV_RENDERER_URL;
  return { application: await electron.launch({ args: link ? [...args, link] : args, env }), args, env };
}
