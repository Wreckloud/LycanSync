import { resolve } from 'node:path';

export function desktopTestEnvironment(directory: string, apiUrl: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.LYCANSYNC_API_URL = apiUrl;
  // 界面回归不扫描本机游戏；沿用开发路径覆盖，不向生产代码添加测试开关。
  env.LYCANSYNC_ACTIVITY_HELPER = resolve(directory, 'unused-activity-helper.exe');
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.LYCANSYNC_DEV_RENDERER_URL;
  return env;
}
