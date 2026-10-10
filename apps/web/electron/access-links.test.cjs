const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAccessLink, accessLinkFromArguments } = require('./access-links.cjs');
const token = 'a'.repeat(43);

test('invitation selects only HTTPS server and an exact credential', () => {
  const offer = parseAccessLink(`lycansync://access?server=https%3A%2F%2Fexample.com#token=${token}`);
  assert.deepEqual(offer, { server: 'https://example.com', token });
  assert.deepEqual(accessLinkFromArguments(['app.exe', `lycansync://access?server=https%3A%2F%2Fexample.com#token=${token}`]), offer);
  assert.deepEqual(accessLinkFromArguments(['app.exe', `lycansync://access/?server=https%3A%2F%2Fexample.com#token=${token}`]), offer);
});
test('rejects host, credentials, duplicate fields, paths and insecure servers', () => {
  for (const link of [
    `lycansync://other?server=https://example.com#token=${token}`,
    `lycansync://access/other?server=https://example.com#token=${token}`,
    `lycansync://access?server=http://example.com#token=${token}`,
    `lycansync://access?server=https://example.com/api#token=${token}`,
    `lycansync://access?server=https://user:password@example.com#token=${token}`,
    `lycansync://access?server=https://example.com&server=https://other.com#token=${token}`,
    `lycansync://access?server=https://example.com#token=${token}&token=${token}`,
    `lycansync://access?server=https://example.com&extra=1#token=${token}`,
    `lycansync://access?server=https://example.com#token=short`,
  ]) assert.throws(() => parseAccessLink(link));
  assert.equal(accessLinkFromArguments(['lycansync://broken']), null);
});
