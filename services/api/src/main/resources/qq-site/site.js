'use strict';

const byId = id => document.getElementById(id);
let sessionToken = null;
let currentUser = null;
let confirming = false;
const feedback = (message, error = false) => {
  byId('feedback').textContent = message;
  byId('feedback').classList.toggle('is-error', error);
};

async function api(path, method = 'GET', body) {
  const response = await fetch('/api/' + path, { method, credentials: 'same-origin', cache: 'no-store',
    signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json',
      ...(sessionToken ? { Authorization: 'Bearer ' + sessionToken } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(result?.detail || '请求未完成，请稍后重试');
  return result;
}

function identity(nickname, avatar) {
  byId('identity').hidden = false;
  byId('nickname').textContent = nickname;
  byId('avatar').src = avatar;
}

function account(user) {
  currentUser = user;
  identity(user.nickname, user.avatar);
  document.body.classList.add('account-page');
  byId('account-title').textContent = '你的 LycanSync 账号';
  byId('account-description').textContent = 'QQ 身份已验证。你可以调整昵称和签名；新账号不会自动加入群组。';
  byId('qq-login').hidden = true;
  byId('result-actions').hidden = true;
  byId('profile-form').hidden = false;
  byId('profile-nickname').value = user.nickname;
  byId('profile-signature').value = user.signature || '';
  history.replaceState(null, '', '/account');
  feedback('登录成功。完整语音与画面共享请使用 Windows 客户端。');
}

async function start() {
  byId('qq-login').disabled = true;
  feedback('正在打开 QQ 官方授权页面…');
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const verifier = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    const result = await api('auth/qq/start', 'POST', { challenge, desktop: false, binding: false });
    const target = new URL(result.authorizationUrl);
    if (target.origin !== location.origin || target.pathname !== '/api/auth/qq/authorize') throw new Error('登录地址与当前服务器不一致');
    sessionStorage.setItem('lycan-qq:' + result.request, verifier);
    location.assign(target.href);
  } catch (error) {
    feedback(error instanceof Error ? error.message : '无法开始 QQ 登录', true);
    byId('qq-login').disabled = false;
  }
}

async function resultPage() {
  const request = new URLSearchParams(location.hash.slice(1)).get('request');
  history.replaceState(null, '', '/qq/result');
  if (!/^[A-Za-z0-9_-]{43}$/.test(request || '')) throw new Error('授权信息已过期，请从首页重新登录');
  const result = await api('auth/qq/result?request=' + encodeURIComponent(request));
  byId('qq-login').hidden = true;
  if (result.error) throw new Error(result.error);
  if (!result.ready) throw new Error('QQ 授权尚未完成，请返回首页重新登录');
  identity(result.nickname, result.avatar);
  byId('account-title').textContent = result.purpose === 'BIND' ? '确认绑定 QQ' : '确认你的账号';
  byId('account-description').textContent = '请核对本次授权的 QQ 昵称和头像。';
  byId('result-actions').hidden = false;
  if (result.desktop) {
    byId('confirm-login').hidden = true;
    byId('return-app').hidden = false;
    byId('return-app').href = 'lycansync://qq?server=' + encodeURIComponent(location.origin) + '#request=' + request;
    feedback('确认后返回原来发起授权的 LycanSync 窗口，继续登录或绑定。');
    return;
  }
  const verifier = sessionStorage.getItem('lycan-qq:' + request);
  if (!verifier) throw new Error('请在原来发起登录的浏览器中继续，或重新登录');
  feedback('确认后登录 LycanSync，不会自动加入群组。');
  byId('confirm-login').onclick = async () => {
    if (confirming) return;
    confirming = true;
    byId('confirm-login').disabled = true;
    feedback('正在确认账号…');
    try {
      const response = await api('auth/qq/exchange', 'POST', { request, verifier });
      sessionToken = response.sessionToken;
      sessionStorage.removeItem('lycan-qq:' + request);
      account(response.user);
    } catch (error) { feedback(error instanceof Error ? error.message : '登录未完成', true); }
    finally { confirming = false; byId('confirm-login').disabled = false; }
  };
}

const privacy = [
  ['我们收集什么', 'QQ 登录用于验证你的账号身份。经你授权，我们读取 QQ 的应用内身份标识（OpenID）、昵称和头像，用于建立或关联 LycanSync 账号。不会读取 QQ 密码、好友列表或聊天记录。'],
  ['账号与内容', '账号资料及 QQ 绑定保存在服务端。已有账号只有主动绑定后才关联，不能凭相同昵称合并。加入群组、聊天、语音和屏幕共享需另行操作；浏览官网或登录不会自动采集麦克风、屏幕或游戏活动。'],
  ['凭据与必要记录', 'QQ 授权令牌仅在服务端临时完成验证，不保存到客户端，也不写入业务日志。授权任务最多保留十分钟；网站只使用短期安全 Cookie 绑定授权浏览器，临时保存发起校验值。网页会话只保留在当前页面内存，刷新后需重新登录。服务会处理必要的 IP、请求及错误信息用于限流和故障排查。'],
  ['桌面数据', 'Windows 客户端的登录凭据、缓存、日志及默认录制文件保存在安装目录内；录制与导出由你主动操作。动态展示与上次在线展示可在客户端独立关闭；具体采集范围以操作时的来源选择和授权为准。'],
  ['资料与退出', '你可以修改昵称、头像和签名，并退出当前会话。QQ 绑定暂不提供自行覆盖或解绑；需要处理账号资料或删除申请时，请通过开发者网站联系维护者。测试数据不会用于广告画像或出售。'],
];
const terms = [
  ['服务范围', 'LycanSync 是面向熟人小队的语音、屏幕共享与协作工具，当前为测试版本。官网提供账号授权与资料确认，完整音视频和录制功能由 Windows 客户端提供；实际可用功能以当前服务器及客户端为准。'],
  ['账号与权限', '使用 QQ 登录仅验证身份，不自动授予管理员权限或加入群组。原账号关联 QQ 必须在已登录状态下主动发起，不能根据昵称、QQ 显示名或本机已登录 QQ 猜测账号。请妥善保管账号与设备。'],
  ['内容与授权', '请只分享和录制你有权处理的内容。语音、屏幕共享、录制和远程控制应取得相关人员同意，不得侵犯隐私、传播违法内容或实施未经授权的控制。'],
  ['测试与反馈', '测试版本可能存在兼容、网络、录制和更新问题。请保留重要文件的独立副本，遇到问题可通过开发者网站反馈。请勿在反馈或截图中公开登录凭据、QQ 应用密钥或他人的私密内容。'],
];

async function initialize() {
  if (location.pathname === '/privacy' || location.pathname === '/terms') {
    byId('product').hidden = true; byId('details').hidden = true; byId('legal').hidden = false;
    const isPrivacy = location.pathname === '/privacy';
    byId('legal-title').textContent = isPrivacy ? '隐私政策' : '用户协议';
    for (const [title, text] of isPrivacy ? privacy : terms) {
      const heading = document.createElement('h2'); heading.textContent = title;
      const paragraph = document.createElement('p'); paragraph.textContent = text;
      byId('legal-content').append(heading, paragraph);
    }
    return;
  }
  if (location.pathname !== '/') document.body.classList.add('account-page');
  if (location.pathname === '/qq/result') { await resultPage(); return; }
  const options = await api('auth/options');
  byId('qq-login').disabled = !options.qqAvailable;
  feedback(options.qqAvailable ? '在 QQ 官方页面完成授权，LycanSync 不接收你的 QQ 密码。' : '服务器尚未开启 QQ 登录，请稍后再试。');
}

byId('qq-login').addEventListener('click', start);
byId('profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (confirming || !currentUser || !sessionToken) return;
  confirming = true;
  const buttons = byId('profile-form').querySelectorAll('button'); buttons.forEach(button => { button.disabled = true; });
  try {
    const user = await api('auth/me', 'PUT', { nickname: byId('profile-nickname').value.trim(), avatar: currentUser.avatar,
      signature: byId('profile-signature').value.trim() });
    account(user); feedback('资料已保存。');
  } catch (error) { feedback(error instanceof Error ? error.message : '无法保存资料', true); }
  finally { confirming = false; buttons.forEach(button => { button.disabled = false; }); }
});
byId('logout').addEventListener('click', async () => {
  if (confirming || !sessionToken) return;
  if (!confirm('退出当前网页账号？')) return;
  confirming = true;
  try { await api('auth/logout', 'POST'); sessionToken = null; currentUser = null; location.assign('/account'); }
  catch (error) { feedback(error instanceof Error ? error.message : '无法退出登录', true); }
  finally { confirming = false; }
});
initialize().catch(error => { feedback(error instanceof Error ? error.message : '页面准备失败，请刷新重试', true); });
