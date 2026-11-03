const assert = require('node:assert/strict');
const { test } = require('node:test');
const { qqLoginFromArguments, validateQqAuthorization } = require('./qq-login.cjs');

test('QQ 唤起只携带服务器与授权任务，不携带业务会话或任意命令', () => {
  const request = 'a'.repeat(43);
  const link = `lycansync://qq?server=https%3A%2F%2Fexample.com#request=${request}`;
  assert.deepEqual(qqLoginFromArguments(['app', link]), { server: 'https://example.com', request });
  for (const value of [link + '&token=secret', link.replace('#request=', '#request=bad&request='),
    link.replace('https%3A', 'http%3A'), link.replace('lycansync://qq', 'lycansync://other')]) {
    assert.equal(qqLoginFromArguments([value]), null);
  }
});

test('只能从当前业务服务器的固定 QQ 授权入口打开系统浏览器', () => {
  const url = `https://example.com/api/auth/qq/authorize?request=${'a'.repeat(43)}`;
  assert.equal(validateQqAuthorization(url, 'https://example.com'), url);
  for (const value of [url.replace('example.com', 'attacker.test'), url + '&redirect=https://attacker.test',
    url.replace('/authorize', '/other'), url.replace('https:', 'http:')]) {
    assert.throws(() => validateQqAuthorization(value, 'https://example.com'));
  }
});
