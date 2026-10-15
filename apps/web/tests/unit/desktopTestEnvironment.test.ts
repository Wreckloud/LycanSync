import { afterEach, expect, test, vi } from 'vitest';
import { resolve } from 'node:path';
import { desktopTestEnvironment } from '../desktop/fixtures/desktopTestEnvironment';

afterEach(() => vi.unstubAllEnvs());

test('桌面回归固定测试服务器和活动路径，清除外部开发页面与 Node 启动参数', () => {
  vi.stubEnv('LYCANSYNC_API_URL', 'https://unrelated.example');
  vi.stubEnv('LYCANSYNC_ACTIVITY_HELPER', resolve('real-activity.exe'));
  vi.stubEnv('LYCANSYNC_DEV_RENDERER_URL', 'http://127.0.0.1:9999/');
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
  const env = desktopTestEnvironment('test-results/profile', 'http://127.0.0.1:18080');
  expect(env.LYCANSYNC_API_URL).toBe('http://127.0.0.1:18080');
  expect(env.LYCANSYNC_ACTIVITY_HELPER).toBe(resolve('test-results/profile/unused-activity-helper.exe'));
  expect(env).not.toHaveProperty('LYCANSYNC_DEV_RENDERER_URL');
  expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  expect(process.env.LYCANSYNC_ACTIVITY_HELPER).toBe(resolve('real-activity.exe'));
});
