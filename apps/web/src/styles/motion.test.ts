import { expect, it } from 'vitest';
import { motionDurationMs } from './motion';

it.each([['260ms', 260], ['.26s', 260], [' 0.21s ', 210], ['120ms', 120],
  ['0s', 0], ['-1s', 0], ['', 0], ['auto', 0], ['Infinitys', 0], ['160', 0]])
  ('动效时长 %s 按实际单位读取为 %i 毫秒', (value, expected) => {
    expect(motionDurationMs(value)).toBe(expected);
  });
