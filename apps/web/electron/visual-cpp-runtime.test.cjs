const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MINIMUM_RUNTIME_VERSION, validateVisualCppRuntime } = require('./visual-cpp-runtime.cjs');

function details(overrides = {}) {
  return { signature: 'Valid', signer: 'CN=Microsoft Corporation, O=Microsoft Corporation, C=US',
    originalFile: 'VC_redist.x64.exe', product: 'Microsoft Visual C++ 2015-2022 Redistributable (x64) - 14.44.35211',
    version: MINIMUM_RUNTIME_VERSION, ...overrides };
}

test('官方 x64 运行库满足最低或较新版本时接受，不要求使用与编译器完全相同的补丁版本', () => {
  assert.equal(validateVisualCppRuntime(details()), MINIMUM_RUNTIME_VERSION);
  assert.equal(validateVisualCppRuntime(details({ version: '14.50.40000.0' })), '14.50.40000.0');
});

test('拒绝无效签名、错误发行方、伪装或不匹配的架构、过旧与不完整版本', () => {
  for (const override of [{ signature: 'NotSigned' }, { signer: 'CN=Other Corporation' },
    { originalFile: 'vc_redist.arm64.exe' }, { product: 'Microsoft Visual C++ Redistributable (x86)' },
    { product: 'Another installer' }, { version: '14.44.35210.0' }, { version: '14.43.40000.0' },
    { version: '14.44' }, { version: '14.44.35211.0-extra' }]) {
    assert.throws(() => validateVisualCppRuntime(details(override)), /VC\+\+/);
  }
});
