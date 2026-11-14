import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('./App.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const source = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'releaseSession');
if (!declaration) throw new Error('会话清理入口不存在');
const compiled = ts.transpile(declaration.getText(source), { target: ts.ScriptTarget.ES2022 });

it.each([false, true])('录像完成前保留人声与连接，停止失败也保存诊断（失败：%s）', async fail => {
  const calls: string[] = [];
  let finish!: () => void;
  const failure = new Error('recording failed');
  const context = {
    recording: { stop: () => new Promise<void>((resolve, reject) => {
      calls.push('recording'); finish = () => fail ? reject(failure) : resolve();
    }), stopReplay: async () => { calls.push('replay'); } },
    microphoneTest: { stop: async () => { calls.push('microphone'); } },
    rtc: { leave: async () => { calls.push('leave'); } },
    diagnosticReport: { flush: vi.fn(async () => { calls.push('report'); }) },
  };
  const release = runInNewContext(`${compiled}; releaseSession`, context) as () => Promise<void>;
  const pending = release();
  expect(calls).toEqual(['recording']);
  finish();
  if (fail) await expect(pending).rejects.toBe(failure);
  else await pending;
  expect(calls).toEqual(['recording', 'replay', 'microphone', 'leave', 'report']);
});
