import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQqMusicLogin, hash33, parsePtuiCallback, setEnvLines } from '../src/qqMusicLogin.js';

const reply = ({ status = 200, body = '', cookies = [], location = '' } = {}) => ({
  ok: status < 400, status,
  headers: { getSetCookie: () => cookies, get: name => (name === 'location' ? location : null) },
  arrayBuffer: async () => Buffer.from(body), text: async () => String(body), json: async () => JSON.parse(body)
});

test('helpers parse ptlogin callbacks and keep other .env lines', () => {
  assert.deepEqual(parsePtuiCallback("ptuiCB('67','0','','0','已扫码。', '')"), ['67', '0', '', '0', '已扫码。', '']);
  assert.equal(hash33(''), 0);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-env-')), '.env');
  fs.writeFileSync(file, 'MUSIC_LIB_BRIDGE_PORT=46231\nQQ_COOKIE=old\n');
  setEnvLines(file, { QQ_COOKIE: 'new', QQ_COOKIE_REFRESHED_AT: 'now' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'MUSIC_LIB_BRIDGE_PORT=46231\nQQ_COOKIE=new\nQQ_COOKIE_REFRESHED_AT=now\n');
});

test('scan flow: QR, waiting, scanned, then the cookie lands in the bridge .env', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-env-')), '.env');
  let pollCount = 0;
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push([new URL(url).pathname, options.headers.Cookie]);
    if (url.includes('/ptqrshow')) return reply({ body: 'PNG', cookies: ['qrsig=abc; Path=/'] });
    if (url.includes('/ptqrlogin')) {
      pollCount += 1;
      if (pollCount === 1) return reply({ body: "ptuiCB('66','0','','0','二维码未失效。', '')" });
      if (pollCount === 2) return reply({ body: "ptuiCB('67','0','','0','二维码认证中。', '')" });
      return reply({ body: "ptuiCB('0','0','https://ptlogin2.graph.qq.com/check_sig?x=1','0','登录成功！', 'nick')", cookies: ['uin=o0123456789; Path=/'] });
    }
    if (url.includes('/check_sig')) return reply({ status: 302, cookies: ['p_skey=pskey; Path=/', 'p_uin=o0123456789; Path=/'] });
    if (url.includes('/oauth2.0/authorize')) return reply({ status: 302, location: 'https://y.qq.com/portal/wx_redirect.html?code=CODE123&state=state' });
    if (url.includes('/musicu.fcg')) {
      assert.match(options.body, /"code":"CODE123"/);
      return reply({ body: JSON.stringify({ req: { code: 0, data: { musicid: 123456789, musickey: 'Q_H_L_KEY', keyExpiresIn: 259200 } } }) });
    }
    throw new Error('unexpected ' + url);
  };
  const login = createQqMusicLogin({ envFile: file, fetchImpl, now: () => Date.parse('2026-10-16T08:00:00Z') });
  const started = await login.start();
  assert.match(started.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal((await login.poll()).status, 'waiting');
  assert.equal((await login.poll()).status, 'scanned');
  const done = await login.poll();
  assert.equal(done.status, 'success');
  assert.equal(done.account, '12****89');
  const env = fs.readFileSync(file, 'utf8');
  assert.match(env, /^QQ_COOKIE=uin=123456789; qqmusic_key=Q_H_L_KEY; qm_keyst=Q_H_L_KEY$/m);
  assert.match(env, /^QQ_COOKIE_EXPIRES_AT=2026-10-19T08:00:00.000Z$/m);
  assert.deepEqual(login.status(), { loggedIn: true, account: '12****89', refreshedAt: '2026-10-16T08:00:00.000Z', expiresAt: '2026-10-19T08:00:00.000Z', provider: 'qq' });
  assert.match(seen.find(([p]) => p === '/ptqrlogin')[1], /qrsig=abc/);
});

test('WeChat flow: long poll in the background, then the cookie is saved as a WeChat login', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-env-')), '.env');
  const polls = ["window.wx_errcode=404;window.wx_code='';", "window.wx_errcode=405;window.wx_code='WXCODE';"];
  const fetchImpl = async (url, options = {}) => {
    if (url.includes('/connect/qrconnect')) return reply({ body: '<img src="/connect/qrcode/UUID_123" />' });
    if (url.includes('/connect/qrcode/UUID_123')) return reply({ body: 'JPEG' });
    if (url.includes('lp.open.weixin.qq.com')) { await new Promise(r => setTimeout(r, 5)); return reply({ body: polls.shift() || "window.wx_errcode=408;window.wx_code='';" }); }
    if (url.includes('/musicu.fcg')) {
      assert.match(options.body, /"code":"WXCODE"/);
      return reply({ body: JSON.stringify({ req: { code: 0, data: { musicid: 987654321, musickey: 'W_X_KEY' } } }) });
    }
    throw new Error('unexpected ' + url);
  };
  const login = createQqMusicLogin({ envFile: file, fetchImpl });
  const started = await login.start('wechat');
  assert.match(started.qrDataUrl, /^data:image\/jpeg;base64,/);
  let state;
  for (let i = 0; i < 50 && (state = await login.poll()).status !== 'success'; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(state.status, 'success');
  assert.match(fs.readFileSync(file, 'utf8'), /^QQ_COOKIE=uin=987654321; wxuin=o987654321; qqmusic_key=W_X_KEY; qm_keyst=W_X_KEY; tmeLoginType=1$/m);
  assert.match(fs.readFileSync(file, 'utf8'), /^QQ_COOKIE_PROVIDER=wechat$/m);
});
