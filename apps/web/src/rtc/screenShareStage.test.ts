import { expect, it } from 'vitest';
import { ScreenShareStage } from './screenShareStage';

it('按观察到的共享开始顺序填满四槽，列表重排不改变等待顺序', () => {
  const stage = new ScreenShareStage();
  stage.sync(['a', 'b']);
  stage.sync(['b', 'a', 'c', 'd', 'e', 'f']);
  expect(stage.slots).toEqual(['a', 'b', 'c', 'd']);
  stage.sync(['f', 'e', 'd', 'c', 'b']);
  expect(stage.slots).toEqual(['e', 'b', 'c', 'd']);
});

it('主动移除和替换者本次不自动补回，重新共享后恢复资格', () => {
  const stage = new ScreenShareStage();
  stage.sync(['a', 'b', 'c', 'd', 'e', 'f']);
  stage.remove('b');
  expect(stage.slots).toEqual(['a', 'e', 'c', 'd']);
  stage.sync(['a', 'b', 'd', 'e', 'f']);
  expect(stage.slots).toEqual(['a', 'e', 'f', 'd']);
  stage.sync(['a', 'd', 'e', 'f']);
  stage.sync(['a', 'b', 'd', 'e', 'f']);
  stage.remove('a');
  expect(stage.slots).toEqual(['b', 'e', 'f', 'd']);
});

it('满员手工放入替换最早进入者，拖动不会改变进入时间', () => {
  const stage = new ScreenShareStage();
  stage.sync(['a', 'b', 'c', 'd', 'e', 'f']);
  stage.move('a', 3);
  expect(stage.slots).toEqual(['d', 'b', 'c', 'a']);
  stage.place('e');
  expect(stage.slots).toEqual(['d', 'b', 'c', 'e']);
  stage.place('e');
  stage.place('f');
  expect(stage.slots).toEqual(['d', 'f', 'c', 'e']);
  stage.remove('c');
  expect(stage.slots).toEqual(['d', 'f', null, 'e']);
});

it('关闭自动填充保留布局；共享停止和移除留下空位，重开只填合格等待者', () => {
  const stage = new ScreenShareStage();
  stage.sync(['a', 'b', 'c', 'd', 'e']);
  stage.setAutoFill(false);
  stage.remove('a');
  stage.sync(['a', 'c', 'd', 'e', 'f']);
  expect(stage.slots).toEqual([null, null, 'c', 'd']);
  stage.move('c', 0);
  expect(stage.slots).toEqual(['c', null, null, 'd']);
  stage.setAutoFill(true);
  expect(stage.slots).toEqual(['c', 'e', 'f', 'd']);
});

it('手工放回重新计时，之后优先替换更早的画面', () => {
  const stage = new ScreenShareStage();
  stage.sync(['a', 'b', 'c', 'd', 'e']);
  stage.setAutoFill(false);
  stage.remove('a');
  stage.place('a');
  stage.place('e');
  expect(stage.slots).toEqual(['a', 'e', 'c', 'd']);
});

it('单路观看保留布局；对应共享停止、移除或被替换后取消单路观看', () => {
  const stage = new ScreenShareStage();
  stage.sync(['a', 'b', 'c', 'd', 'e']);
  stage.toggleFocus('b');
  expect(stage.focused).toBe('b');
  stage.toggleFocus('b');
  expect(stage.slots).toEqual(['a', 'b', 'c', 'd']);
  stage.toggleFocus('a');
  stage.place('e');
  expect(stage.focused).toBeNull();
  stage.toggleFocus('b');
  stage.remove('b');
  expect(stage.focused).toBeNull();
  stage.toggleFocus('c');
  stage.sync(['a', 'b', 'd', 'e']);
  expect(stage.focused).toBeNull();
});

it('忽略无效或迟到的操作，离房清理队列与排除记录但保留个人设置', () => {
  const stage = new ScreenShareStage();
  stage.setAutoFill(false);
  stage.sync(['a']);
  stage.place('a');
  stage.move('a', -1);
  stage.move('a', 4);
  stage.move('a', 1.5);
  stage.place('missing');
  stage.toggleFocus('missing');
  expect(stage.slots).toEqual(['a', null, null, null]);
  stage.remove('a');
  stage.reset();
  stage.sync(['a']);
  expect(stage.slots).toEqual([null, null, null, null]);
  stage.setAutoFill(true);
  expect(stage.slots).toEqual(['a', null, null, null]);
});
