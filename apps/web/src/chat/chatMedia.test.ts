import { expect, it } from 'vitest';
import { chatMediaFormat } from './chatMedia';

it('普通文件只按最后一个扩展名提供预览，不把日志和网页当作媒体', () => {
  const file = (fileName: string) => ({ id: 'test', contentType: 'application/octet-stream', byteSize: 10, fileName });
  expect(chatMediaFormat(file('视频.MP4'))?.kind).toBe('video');
  expect(chatMediaFormat(file('音乐.mp3'))?.kind).toBe('audio');
  expect(chatMediaFormat(file('图片.gif'))?.kind).toBe('image');
  expect(chatMediaFormat(file('1.mp4.log'))).toBeNull();
  expect(chatMediaFormat(file('page.html'))).toBeNull();
  expect(chatMediaFormat(file('image.svg'))).toBeNull();
});

it('原有聊天图片没有文件名时沿用服务器返回的图片类型', () => {
  expect(chatMediaFormat({ id: 'image', byteSize: 10, contentType: 'image/png' }))
    .toEqual({ kind: 'image', contentType: 'image/png' });
});
