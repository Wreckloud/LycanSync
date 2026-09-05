import type { BrowserContext } from '@playwright/test';

/** 仅在浏览器集成测试中替换 Vite 模块，保留跨群组切换测试，不向产品注入测试入口。 */
export async function installTestRooms(context: BrowserContext) {
  await context.route('**/src/localRooms.ts*', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `export const LOCAL_ROOMS = ${JSON.stringify([
      { id: 'pack', shortName: '开', name: '开黑小队' },
      { id: 'racing', shortName: '车', name: '周末车队' },
    ])};`,
  }));
}
