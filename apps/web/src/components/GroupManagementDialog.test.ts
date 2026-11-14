import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, nextTick, ref } from 'vue';
import { expect, it, vi } from 'vitest';

const script = parse(readFileSync(new URL('./GroupManagementDialog.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const source = ts.createSourceFile('GroupManagementDialog.ts', script, ts.ScriptTarget.Latest, true);
const names = ['chooseDisposition', 'selectMember', 'confirm', 'action', 'close'];
const compiled = ts.transpile(source.statements.filter(statement => ts.isFunctionDeclaration(statement)
  && names.includes(statement.name?.text ?? '')).map(statement => statement.getText(source)).join('\n'), { target: ts.ScriptTarget.ES2022 });
function setup() {
  const disposition = ref('transfer');
  const confirmation = ref<{ userId: string; nickname: string } | null>(null);
  const transferName = ref('');
  const state = { props: { group: { id: 'group', name: '群组' }, userId: 'owner', mode: 'resolve', pending: false },
    showingConfirmation: ref(false), disposition, mode: computed(() => disposition.value), confirmation, transferName, dissolveName: ref('群'),
    dissolveNameMatches: ref(false), transferNameMatches: computed(() => !!confirmation.value && transferName.value === confirmation.value.nickname),
    busy: ref(false), disposed: false, error: ref(''), status: ref(''), dialog: ref(null), emit: vi.fn(),
    transferGroupOwner: vi.fn(async () => ({ id: 'group', role: 'MEMBER' })), dissolveGroup: vi.fn(async () => {}),
  };
  const actions = runInNewContext(`${compiled}; ({ ${names.join(', ')} })`, { ...state, nextTick, Error }) as {
    chooseDisposition(mode: string): Promise<void>; selectMember(member: { userId: string; nickname: string }): void;
    confirm(): Promise<void>; close(): void;
  };
  return { state, ...actions };
}
it('切换转让和解散保留所选成员及两侧输入，必须准确输入昵称才能转让', async () => {
  const f = setup();
  f.selectMember({ userId: 'friend', nickname: '朋友' });
  f.state.transferName.value = '朋';
  f.close();
  expect(f.state.showingConfirmation.value).toBe(false);
  expect(f.state.transferName.value).toBe('朋');
  f.selectMember({ userId: 'friend', nickname: '朋友' });
  expect(f.state.transferName.value).toBe('朋');
  await f.chooseDisposition('dissolve');
  await f.chooseDisposition('transfer');
  expect(f.state.confirmation.value?.userId).toBe('friend');
  expect(f.state.transferName.value).toBe('朋');
  expect(f.state.dissolveName.value).toBe('群');
  await f.confirm();
  expect(f.state.transferGroupOwner).not.toHaveBeenCalled();
  f.state.transferName.value = '朋友';
  await f.confirm();
  expect(f.state.transferGroupOwner).toHaveBeenCalledExactlyOnceWith('group', 'friend');
  expect(f.state.emit).toHaveBeenCalledWith('updated', { id: 'group', role: 'MEMBER' });
  expect(f.state.emit).not.toHaveBeenCalledWith('close');
});
it('切换接任人清除旧确认昵称，处理中不能重复转让或关闭', async () => {
  const f = setup();
  f.selectMember({ userId: 'friend', nickname: '朋友' });
  f.state.transferName.value = '朋友';
  f.selectMember({ userId: 'other', nickname: '另一位' });
  expect(f.state.transferName.value).toBe('');
  f.state.busy.value = true;
  f.state.transferName.value = '另一位';
  await f.confirm(); f.close();
  expect(f.state.transferGroupOwner).not.toHaveBeenCalled();
  expect(f.state.emit).not.toHaveBeenCalled();
});
