import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { effectScope, nextTick, reactive, ref, watch } from 'vue';
import { expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('./App.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const start = script.indexOf('const appNotice =');
const source = ts.transpile(script.slice(start, script.indexOf('const settingsReturnFocus', start)));

it('关闭只移除展示，旧错误不挡成功，同文案的新操作重新展示', async () => {
  const scope = effectScope();
  const rtc = reactive({ notice: '连接失败' });
  const viewerNotice = ref('');
  const recording = { notice: ref(''), successNotice: ref<{ message: string } | null>(null) };
  const settingsOpen = ref(false);
  const settingsSection = ref('account');
  const props = reactive({ startupUpdateWarning: '' });
  const emit = vi.fn();
  const state = scope.run(() => runInNewContext(`${source}\n({ appNotice, dismissAppNotice })`, {
    ref, watch, rtc, viewerNotice, recording, settingsOpen, settingsSection, props, emit,
  })) as { appNotice: { value: { id: number; message: string; kind?: string } | null }; dismissAppNotice(): void };
  try {
    expect(state.appNotice.value?.message).toBe('连接失败');
    state.dismissAppNotice();
    expect(state.appNotice.value).toBeNull();
    expect(rtc.notice).toBe('连接失败');
    recording.successNotice.value = { message: '回放已保存到本地录像' };
    await nextTick();
    expect(state.appNotice.value?.kind).toBe('success');
    const id = state.appNotice.value?.id;
    recording.successNotice.value = { message: '回放已保存到本地录像' };
    await nextTick();
    expect(state.appNotice.value?.id).not.toBe(id);
    expect(state.appNotice.value?.message).toBe('回放已保存到本地录像');
    state.dismissAppNotice();
    settingsOpen.value = true;
    settingsSection.value = 'recording';
    recording.notice.value = '保存目录不可用';
    await nextTick();
    expect(state.appNotice.value).toBeNull();
    expect(recording.notice.value).toBe('保存目录不可用');
    props.startupUpdateWarning = '更新失败';
    await nextTick();
    state.dismissAppNotice();
    expect(emit).toHaveBeenCalledWith('dismissUpdateWarning');
  } finally { scope.stop(); }
});
