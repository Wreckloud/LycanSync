import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { effectScope, nextTick, reactive, ref, watch } from 'vue';
import { expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('./RemoteAudio.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('RemoteAudio.ts', script, ts.ScriptTarget.Latest, true);
const compiled = ts.transpile(sourceFile.statements.filter((statement) => !ts.isImportDeclaration(statement))
  .map((statement) => statement.getText(sourceFile)).join('\n'), { target: ts.ScriptTarget.ES2022 });

it('播放组件保持单次挂载，静音同步生效且先分离音轨再释放插件', async () => {
  const order: string[] = [];
  const track = { attach: vi.fn(), detach: vi.fn(() => order.push('detach')), setVolume: vi.fn() };
  const props = reactive({ track, context: {}, volume: 1, balance: true });
  const enabled = vi.fn();
  const audible = vi.fn();
  const dispose = vi.fn(() => order.push('dispose'));
  const scope = effectScope();
  const { audioElement } = scope.run(() => runInNewContext(`${compiled}\n({ audioElement })`, {
    ref, watch, defineProps: () => props, defineEmits: () => vi.fn(),
    RemoteVoiceBalance: class { setEnabled = enabled; setAudible = audible; dispose = dispose; },
  })) as { audioElement: { value: unknown } };
  audioElement.value = {};
  await nextTick();
  expect(track.attach).toHaveBeenCalledTimes(1);
  expect(enabled).toHaveBeenLastCalledWith(true);
  props.balance = false;
  await nextTick();
  expect(enabled).toHaveBeenLastCalledWith(false);
  props.volume = 0;
  expect(audible).toHaveBeenLastCalledWith(false);
  expect(track.setVolume).toHaveBeenLastCalledWith(0);
  expect(track.attach).toHaveBeenCalledTimes(1);
  scope.stop();
  expect(order).toEqual(['detach', 'dispose']);
});
