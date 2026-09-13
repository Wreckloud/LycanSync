import { installAuthenticatedRtc } from './authenticatedRtc';
import type { BrowserContext } from '@playwright/test';

/** 通过测试 API 返回真实形状的群组，不修改生产模块。 */
export async function installTestGroups(context: BrowserContext) {
  await installAuthenticatedRtc(context);
}
