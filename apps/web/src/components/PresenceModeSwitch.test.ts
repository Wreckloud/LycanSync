import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('./PresenceModeSwitch.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;

it('状态未就绪或页面未激活时不提交，相同状态仅在同步失败后允许重试', () => {
  const props = { mode: 'online', ready: false, active: true, error: '' };
  const emit = vi.fn();
  const state = runInNewContext(`${ts.transpile(script.replace(/^import .*;\r?\n/gm, ''))}\n({ select })`, {
    defineProps: () => props, defineEmits: () => emit,
  }) as { select(mode: string): void };
  state.select('invisible');
  props.ready = true; props.active = false;
  state.select('invisible');
  expect(emit).not.toHaveBeenCalled();
  props.active = true;
  state.select('online');
  expect(emit).not.toHaveBeenCalled();
  state.select('invisible');
  expect(emit).toHaveBeenCalledExactlyOnceWith('select', 'invisible');
  props.mode = 'invisible'; props.error = '尚未同步';
  state.select('invisible');
  expect(emit).toHaveBeenCalledTimes(2);
});
