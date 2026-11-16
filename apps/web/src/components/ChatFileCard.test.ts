import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, onScopeDispose, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import { chatMediaFormat } from '../chat/chatMedia';

const script = parse(readFileSync(new URL('./ChatFileCard.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const parsed = ts.createSourceFile('card.ts', script, ts.ScriptTarget.Latest, true);
const compiled = ts.transpile(parsed.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(parsed)).join('\n'), { target: ts.ScriptTarget.ES2022 });

function setup() {
  const scope = effectScope();
  const downloadFile = vi.fn(async (_group: string, _attachment: unknown, _signal: AbortSignal) => {});
  const card = scope.run(() => runInNewContext(`${compiled}\n({download,cancel,error,downloading})`, {
    computed, ref, onScopeDispose, chatMediaFormat, downloadFile, AbortController, Error, DOMException,
    defineProps: () => ({ groupId: 'group', attachment: { id: 'file', fileName: 'test.dat', byteSize: 4 } }),
    defineEmits: () => vi.fn(),
  })) as { download(): Promise<void>; cancel(): void; error: { value: string }; downloading: { value: boolean } };
  return { scope, card, downloadFile };
}

it('取消系统保存框不显示失败，随后仍可重新下载', async () => {
  const f = setup();
  try {
    f.downloadFile.mockRejectedValueOnce(new DOMException('用户取消保存', 'AbortError'));
    await f.card.download();
    expect(f.card.error.value).toBe('');
    expect(f.card.downloading.value).toBe(false);
    await f.card.download();
    expect(f.downloadFile).toHaveBeenCalledTimes(2);
    expect(f.card.error.value).toBe('');
  } finally { f.scope.stop(); }
});

it('真实保存失败仍明确显示错误，重试成功清除旧错误', async () => {
  const f = setup();
  try {
    f.downloadFile.mockRejectedValueOnce(new Error('磁盘写入失败'));
    await f.card.download();
    expect(f.card.error.value).toBe('磁盘写入失败');
    await f.card.download();
    expect(f.card.error.value).toBe('');
  } finally { f.scope.stop(); }
});

it('卸载取消正在进行的下载，迟到的取消结果不显示失败', async () => {
  const f = setup();
  let reject!: (reason: Error) => void;
  f.downloadFile.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const downloading = f.card.download();
  const signal = f.downloadFile.mock.calls[0][2];
  f.scope.stop();
  expect(signal.aborted).toBe(true);
  reject(new Error('请求已取消'));
  await downloading;
  expect(f.card.error.value).toBe('');
});
