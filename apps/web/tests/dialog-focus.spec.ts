import { expect, test } from '@playwright/test';

test('公共弹窗焦点跳过隐藏、禁用和退场控件，字段移除及忙碌时不离开弹窗', async ({ page }) => {
  await page.route('**/api/**', route => route.abort());
  await page.route('**/src/main.ts*', route => route.fulfill({ contentType: 'text/javascript', body: `
import { keepDialogFocus } from '/src/components/dialogFocus.ts';
document.querySelector('#root').innerHTML = '<button id="outside">背景</button><section id="dialog" role="dialog" tabindex="-1">'
  + '<button id="first">首项</button><input hidden><button disabled>禁用</button>'
  + '<fieldset disabled><button>禁用组</button></fieldset><div hidden><button>隐藏组</button></div>'
  + '<div inert><button>退场组</button></div><button style="visibility:hidden">不可见</button>'
  + '<input id="middle"><button id="last">末项</button><button tabindex="-1">跳过</button></section>';
document.querySelector('#dialog').addEventListener('keydown', keepDialogFocus);
document.querySelector('#dialog').focus();
` }));
  await page.goto('/');
  const dialog = page.getByRole('dialog');
  const first = page.locator('#first'), last = page.locator('#last'), middle = page.locator('#middle');
  await expect(dialog).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(middle).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(last).toBeFocused();
  await last.evaluate(element => { (element as HTMLButtonElement).disabled = true; });
  await first.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(middle).toBeFocused();
  await dialog.evaluate(element => {
    element.querySelectorAll('button, input').forEach(control => { (control as HTMLButtonElement).disabled = true; });
    (element as HTMLElement).focus();
  });
  await page.keyboard.press('Tab');
  await expect(dialog).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog).toBeFocused();
});
