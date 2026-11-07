import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('../../src/App.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const ast = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);
const selected = ast.statements.filter(statement =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === 'preloadCaptureSources'
  || ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration =>
    ts.isIdentifier(declaration.name) && ['captureIntentPending', 'captureIntentAt'].includes(declaration.name.text)));
const code = ts.transpile(selected.map(statement => statement.getText(ast)).join('\n'), { target: ts.ScriptTarget.ES2022 });

function fixture() {
  const desktop = { listNativeVideoSources: vi.fn(async () => ({ sources: [
    { sourceId: 'window:1:1', kind: 'window' }, { sourceId: 'monitor:1:1', kind: 'monitor' },
  ] })), getNativeVideoSourceThumbnails: vi.fn(async (_sources: unknown[]) => []) };
  const realm = { desktop, appDisposed: false, document: { hidden: false }, connected: { value: true },
    captureRequest: { value: null as object | null }, rtc: { room: {}, screenShareActive: false },
    lastCaptureSourceType: 'screen', console: { warn: vi.fn() }, Date };
  const preload = runInNewContext(`${code}\npreloadCaptureSources`, realm) as () => Promise<void>;
  return { realm, desktop, preload };
}

it('按上次来源分类预取，并合并连续意图；不打开选择器或开始共享', async () => {
  const f = fixture();
  await Promise.all([f.preload(), f.preload()]);
  expect(f.desktop.listNativeVideoSources).toHaveBeenCalledTimes(1);
  expect(f.desktop.getNativeVideoSourceThumbnails).toHaveBeenCalledWith([{ sourceId: 'monitor:1:1', kind: 'monitor' }]);
  await f.preload();
  expect(f.desktop.listNativeVideoSources).toHaveBeenCalledTimes(1);
  expect(f.realm.captureRequest.value).toBeNull();
  expect(f.realm.rtc.screenShareActive).toBe(false);
});

it.each(['hidden', 'disconnected', 'disposed', 'picker', 'sharing'])('%s 时不预取', async reason => {
  const f = fixture();
  if (reason === 'hidden') f.realm.document.hidden = true;
  if (reason === 'disconnected') f.realm.connected.value = false;
  if (reason === 'disposed') f.realm.appDisposed = true;
  if (reason === 'picker') f.realm.captureRequest.value = {};
  if (reason === 'sharing') f.realm.rtc.screenShareActive = true;
  await f.preload();
  expect(f.desktop.listNativeVideoSources).not.toHaveBeenCalled();
});

it('枚举期间离开原房间，迟到结果不继续抓取画面', async () => {
  const f = fixture();
  f.desktop.listNativeVideoSources.mockImplementation(async () => {
    f.realm.rtc.room = {};
    return { sources: [{ sourceId: 'window:1:1', kind: 'window' }] };
  });
  await f.preload();
  expect(f.desktop.getNativeVideoSourceThumbnails).not.toHaveBeenCalled();
});
