import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { effectScope, nextTick, onScopeDispose, ref, watch } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import type { MemberOption } from './MemberPicker.vue';

const script = parse(readFileSync(new URL('./MemberPicker.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const source = ts.createSourceFile('MemberPicker.ts', script, ts.ScriptTarget.Latest, true);
const names = ['loadMore', 'checkScroll'];
const compiled = ts.transpile(source.statements.filter(statement => {
  if (ts.isFunctionDeclaration(statement)) return names.includes(statement.name?.text ?? '');
  const text = statement.getText(source);
  return /^(let |watch\(search|onScopeDispose\()/.test(text);
}).map(statement => statement.getText(source)).join('\n'), { target: ts.ScriptTarget.ES2022 });
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.useRealTimers(); });
function setup() {
  vi.useFakeTimers();
  const scope = effectScope(); scopes.push(scope);
  const load = vi.fn((_query: string, _offset: number, _signal: AbortSignal): Promise<{ members: MemberOption[]; hasMore: boolean }> =>
    Promise.resolve({ members: [{ userId: 'friend', nickname: '朋友', avatar: '' }], hasMore: false }));
  const state = { props: { load, disabled: false }, loading: ref(false), error: ref(''), search: ref(''),
    results: ref<MemberOption[]>([]), hasMore: ref(false), list: ref<{ scrollHeight: number; scrollTop: number; clientHeight: number } | null>(null) };
  const actions = scope.run(() => runInNewContext(`${compiled}; ({ loadMore, checkScroll })`,
    { ...state, nextTick, watch, onScopeDispose, AbortController, Error, setTimeout, clearTimeout })) as { loadMore(): Promise<void>; checkScroll(): void };
  return { state, scope, ...actions };
}
it('搜索立即撤销旧请求，迟到结果不能覆盖新搜索，卸载取消后续读取', async () => {
  const f = setup();
  let complete!: (page: { members: MemberOption[]; hasMore: boolean }) => void;
  f.state.props.load.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const old = f.loadMore();
  const signal = f.state.props.load.mock.calls[0][2];
  f.state.search.value = '新'; await nextTick();
  expect(signal.aborted).toBe(true);
  complete({ members: [{ userId: 'old', nickname: '旧结果', avatar: '' }], hasMore: true }); await old;
  expect(f.state.results.value).toEqual([]);
  await vi.advanceTimersByTimeAsync(250);
  expect(f.state.props.load.mock.calls[1].slice(0, 2)).toEqual(['新', 0]);
  expect(f.state.results.value[0].userId).toBe('friend');
  f.state.search.value = '取消'; await nextTick(); f.scope.stop();
  await vi.advanceTimersByTimeAsync(250);
  expect(f.state.props.load).toHaveBeenCalledTimes(2);
});
it('滚动接近底部追加下一页，失败保留已有成员并从同一偏移重试', async () => {
  const f = setup();
  f.state.props.load.mockResolvedValueOnce({ members: [{ userId: 'first', nickname: '首位', avatar: '' }], hasMore: true });
  await f.loadMore();
  f.state.props.load.mockRejectedValueOnce(new Error('读取失败'));
  await f.loadMore();
  expect(f.state.results.value.map(member => member.userId)).toEqual(['first']);
  expect(f.state.error.value).toBe('读取失败');
  await f.loadMore();
  expect(f.state.props.load.mock.calls.slice(1).map(call => call[1])).toEqual([1, 1]);
  expect(f.state.results.value.map(member => member.userId)).toEqual(['first', 'friend']);
  f.state.hasMore.value = true;
  f.state.list.value = { scrollHeight: 600, scrollTop: 100, clientHeight: 260 };
  f.checkScroll(); expect(f.state.props.load).toHaveBeenCalledTimes(3);
  f.state.list.value.scrollTop = 340; f.checkScroll();
  expect(f.state.props.load).toHaveBeenCalledTimes(4);
});
