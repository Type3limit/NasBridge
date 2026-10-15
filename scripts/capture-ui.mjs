import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.UI_TEST_BASE || 'http://127.0.0.1:4179';
const out = process.env.UI_TEST_OUTPUT || 'local/ui-review';
fs.mkdirSync(out, { recursive: true });
const profile = { id: 'layout-user', displayName: '管理员', role: 'admin', email: 'admin@nasbridge.online', bio: '远端存储网络管理员' };
const clients = [
  { id: 'client-one', name: 'HOME / 主存储节点', status: 'online', lastHeartbeatAt: new Date().toISOString() },
  { id: 'client-two', name: 'STUDIO / 备份节点', status: 'online', lastHeartbeatAt: new Date().toISOString() }
];
const files = [
  ['01', '工业现场记录_2026.mp4', 'video/mp4', 283000000, '现场记录'],
  ['02', '项目部署指南.pdf', 'application/pdf', 1450000, '工作文档'],
  ['03', '通讯协议_v2.md', 'text/markdown', 48620, '工作文档'],
  ['04', '远端机房_概念图.jpg', 'image/jpeg', 3920120, '设计素材'],
  ['05', '轨道之外 — 原声集.flac', 'audio/flac', 38470200, '音乐'],
  ['06', '一个用于检查排版和省略显示的超长文件名_终端多副本归档与版本记录.zip', 'application/zip', 130470200, '工作文档'],
  ['07', '山间电台_第01集.mp4', 'video/mp4', 530420000, '现场记录'],
  ['08', '节点诊断.log', 'text/plain', 24128, '工作文档']
].map(([id, name, mimeType, size, columnId]) => ({ id, name, mimeType, size, columnId, path: name, clientId: 'client-one', tags: id === '01' ? ['现场', '已归档'] : ['工作'], createdAt: new Date().toISOString(), favorite: id === '02' }));
const shared = { id: 'share-01', status: 'active', createdAt: new Date().toISOString(), expiresAt: null, accessCount: 12, fileId: '02', file: files[1], shareUrl: 'https://nasbridge.online/share.html?id=demo' };
const errors = [];
const overflows = [];
const obstructions = [];
const browser = await chromium.launch({ channel: process.env.UI_TEST_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
let lastPage;
async function fixture(route) {
  const url = new URL(route.request().url());
  const key = url.pathname;
  let body = { messages: [], jobs: [], bots: [], channels: [], members: [], sources: [], items: [], config: {}, data: [], files, clients, shares: [shared], columns: [], directories: [], danmaku: [], comments: [], total: 0 };
  if (key === '/api/me') body = { profile };
  if (key === '/api/files') body = { files, directories: [] };
  if (key === '/api/clients' || key === '/api/admin/clients') body = { clients };
  if (key === '/api/admin/users') body = { users: [profile, { ...profile, id: 'member', displayName: '协作成员', email: 'member@example.com', role: 'user' }] };
  if (key === '/api/shares') body = { shares: [shared] };
  if (key === '/api/sync-groups') body = { groups: [], capabilities: Object.fromEntries(clients.map(client => [client.id, { protocol: 3 }])) };
  if (key === '/api/chat/messages') body = { messages: [{ id: 'message-01', createdAt: new Date().toISOString(), author: { id: 'member', displayName: '协作成员' }, text: '存储节点已经同步。新的现场记录和项目文档已归档，可以开始今天的工作。', attachments: [] }] };
  if (key === '/api/columns') body = { columns: ['工作文档', '现场记录', '设计素材', '音乐'].map(id => ({ id, name: id })) };
  if (key.includes('/share') && key !== '/api/shares') body = { share: shared, file: files[1], client: clients[0], shareToken: '', accessToken: '' };
  if (key.includes('calendar')) body = [{ weekday: { id: new Date().getDay() || 7, cn: '今日' }, items: [{ id: 100, name: '山间电台', name_cn: '山间电台', images: {}, rating: { score: 8.2 }, summary: '穿越山野，寻找连接世界的声音。' }] }];
  return route.fulfill({ json: body });
}
async function shot(page, name) {
  await page.locator('img').evaluateAll(nodes => Promise.all(nodes.filter(node => node.getAttribute('src')).map(node => node.decode().catch(() => {}))));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const result = await page.evaluate(() => ({ width: innerWidth, doc: document.documentElement.scrollWidth, theme: document.documentElement.dataset.theme }));
  if (result.doc > result.width + 1) overflows.push({ name, ...result });
  const obstruction = await page.evaluate(() => {
    const dialog = document.querySelector('.overlay .modalWindow');
    const toast = document.querySelector('.toastViewport');
    if (!dialog || !toast) return false;
    const a = dialog.getBoundingClientRect(), b = toast.getBoundingClientRect();
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  });
  if (obstruction) obstructions.push(name);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
}
try {
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(mode => { localStorage.setItem('nas_ui_theme', mode); }, theme);
    await context.route('**/api/**', fixture);
    await context.route('https://api.bgm.tv/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      const subject = { id: 100, name: 'Radio over the Frontier', name_cn: '山间电台', images: {}, rating: { score: 8.2, rank: 142 }, summary: '沿着群山与河谷的电台信号，寻找连接世界的声音。一次关于探索、协作和归途的旅程。', eps: 12, date: '2026-10-01' };
      const json = pathname === '/calendar' ? [{ weekday: { id: new Date().getDay() || 7, cn: '今日' }, items: [subject] }] : pathname.includes('/episodes') ? { data: [{ id: 101, sort: 1, name_cn: '第一束信号', airdate: '2026-10-01' }], total: 1 } : /\/subjects\/100$/.test(pathname) ? subject : { data: [subject], total: 1 };
      return route.fulfill({ json });
    });
    await context.route('https://beian.mps.gov.cn/**', route => route.abort());
    await context.routeWebSocket(/.*/, socket => socket.onMessage(() => {}));
    const page = await context.newPage();
    lastPage = page;
    page.on('pageerror', error => errors.push({ theme, message: error.message }));
    page.on('response', response => { if (response.url().includes('/assets/') && response.status() >= 400) errors.push({ theme, message: `Asset ${response.status()}: ${response.url()}` }); });
    await page.goto(base);
    await page.getByPlaceholder('name@example.com').waitFor();
    await page.locator('.accessArtwork').evaluate(img => img.decode());
    await shot(page, `${theme}-login`);
    await page.getByRole('tab', { name: /注册/ }).click();
    await shot(page, `${theme}-register`);
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, `${theme}-mobile-register`);
    await page.getByRole('tab', { name: /登录/ }).click();
    await shot(page, `${theme}-mobile-login`);
    await page.evaluate(() => localStorage.setItem('nas_token', 'ui-layout-test'));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await page.getByTitle('资源浏览器', { exact: true }).waitFor();
    await page.locator('.gridItem').first().waitFor();
    await shot(page, `${theme}-explorer`);
    await page.getByRole('button', { name: '列表模式', exact: true }).click();
    await shot(page, `${theme}-explorer-list`);
    await page.getByRole('button', { name: '图标模式', exact: true }).click();
    for (const title of ['聊天室', '系统概览', '终端状态', '传输队列', '分享管理', '用户管理', '终端管理', 'TV直播', '番剧']) {
      await page.getByTitle(title, { exact: true }).click();
      if (title === '聊天室') await page.getByPlaceholder(/Enter 发送/).waitFor();
      if (title === 'TV直播') await page.locator('[class^="tv"]').first().waitFor();
      if (title === '番剧') await page.locator('.animePage').waitFor();
      await shot(page, `${theme}-${title}`);
    }
    await page.getByTitle('资源浏览器', { exact: true }).click();
    const firstCard = page.locator('.gridItem').first();
    await page.locator('.gridItem').filter({ hasText: '工业现场记录_2026.mp4' }).getByRole('button', { name: '预览', exact: true }).click();
    await page.locator('.previewModal:not(.previewFallbackModal)').waitFor();
    assert.equal(await page.locator('.previewHeaderTitle').innerText(), '工业现场记录_2026.mp4');
    assert.equal(await page.locator('.playerSurface > .fui-Spinner .fui-Spinner__label').evaluate(label => getComputedStyle(label).color), 'rgb(243, 244, 237)');
    await shot(page, `${theme}-video-preview-loading`);
    await page.locator('.previewModal').getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('.gridItem').filter({ hasText: '通讯协议_v2.md' }).getByRole('button', { name: '预览', exact: true }).click();
    await page.locator('.previewModal:not(.previewFallbackModal)').waitFor();
    assert.equal(await page.locator('.previewHeaderTitle').innerText(), '通讯协议_v2.md');
    await shot(page, `${theme}-text-preview-loading`);
    await page.locator('.previewModal').getByRole('button', { name: '关闭', exact: true }).click();
    while (await page.locator('.toastClose').count()) await page.locator('.toastClose').first().click();
    await firstCard.getByRole('button', { name: '编辑', exact: true }).click();
    await page.locator('.editFileModal').waitFor();
    await page.locator('.editFileModal').getByRole('button', { name: /展开更多设置/ }).click();
    await shot(page, `${theme}-edit-file`);
    await page.locator('.editFileModal').getByRole('button', { name: '关闭', exact: true }).click();
    await firstCard.getByRole('button', { name: '分享', exact: true }).click();
    await page.locator('.shareModal').waitFor();
    await shot(page, `${theme}-share-dialog`);
    await page.locator('.shareModal').getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
    await page.locator('.createFolderDialog').waitFor();
    await shot(page, `${theme}-create-folder`);
    await page.locator('.createFolderDialog').getByRole('button', { name: '取消', exact: true }).first().click();
    await page.getByRole('button', { name: '上传文件', exact: true }).click();
    await page.locator('.uploadModal').waitFor();
    await shot(page, `${theme}-upload`);
    await page.locator('.uploadModal').getByRole('button', { name: '继续', exact: true }).click();
    await page.locator('.uploadModal input[type="file"]').first().setInputFiles({ name: '节点备份清单.txt', mimeType: 'text/plain', buffer: Buffer.from('layout review file') });
    await shot(page, `${theme}-upload-step2`);
    await page.locator('.uploadModal').getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('.profileTrigger').click();
    await page.locator('.profileDialog').waitFor();
    await shot(page, `${theme}-profile`);
    await page.getByRole('button', { name: '关闭个人资料', exact: true }).click();
    await page.getByTitle('系统概览', { exact: true }).click();
    await page.getByRole('button', { name: /链路诊断/ }).click();
    await page.locator('.diagnosticsDrawer').waitFor();
    await shot(page, `${theme}-diagnostics`);
    await page.locator('.diagnosticsDrawer').getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByTitle('资源浏览器', { exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, `${theme}-mobile-explorer`);
    await page.getByRole('button', { name: '用户档案', exact: true }).click();
    await page.locator('.profileDialog').waitFor();
    await shot(page, `${theme}-mobile-profile`);
    await page.getByRole('button', { name: '关闭个人资料', exact: true }).click();
    await page.getByRole('button', { name: '上传文件', exact: true }).click();
    await page.locator('.uploadModal').waitFor();
    await shot(page, `${theme}-mobile-upload`);
    await page.locator('.uploadModal').getByRole('button', { name: '继续', exact: true }).click();
    await page.locator('.uploadModal input[type="file"]').first().setInputFiles({ name: '节点备份清单_检查移动端长文件名称展示.txt', mimeType: 'text/plain', buffer: Buffer.from('layout review file') });
    await shot(page, `${theme}-mobile-upload-step2`);
    await page.locator('.uploadSelectionPanel').scrollIntoViewIfNeeded();
    assert((await page.locator('.uploadSelectionPanel input').evaluateAll(inputs => inputs.map(input => input.value))).includes('节点备份清单_检查移动端长文件名称展示.txt'));
    await shot(page, `${theme}-mobile-upload-files`);
    await page.locator('.uploadModal').getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('.gridItem').first().getByRole('button', { name: '分享', exact: true }).click();
    await page.locator('.shareModal').waitFor();
    await shot(page, `${theme}-mobile-share-dialog`);
    await page.locator('.shareModal').getByRole('button', { name: '关闭', exact: true }).click();
    for (const [label, selector] of [['聊天', '.chatRoomShell'], ['概览', '.operationsOverview'], ['直播', '.tvStreamRoot']]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.locator(selector).waitFor();
      await shot(page, `${theme}-mobile-${label}`);
    }
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await page.locator('.mobileMoreSheet.open').waitFor();
    await shot(page, `${theme}-mobile-more`);
    await page.locator('.mobileMoreSheet.open').getByRole('button', { name: '番剧', exact: true }).click();
    await page.locator('.animePage').waitFor({ state: 'attached' });
    console.log('mobile anime bounds', await page.locator('.animePage').evaluate(node => ({ width: node.clientWidth, height: node.clientHeight })));
    await shot(page, `${theme}-mobile-anime`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base + '/share.html?share=demo');
    await page.locator('.shareHeroPanel').waitFor();
    await shot(page, `${theme}-public-share`);
    await page.setViewportSize({ width: 375, height: 812 });
    await shot(page, `${theme}-mobile-public-share`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base + '/living-room.html');
    await page.locator('.lrBrowse').waitFor();
    await shot(page, `${theme}-living-room`);
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, `${theme}-mobile-living-room`);
    await page.setViewportSize({ width: 375, height: 812 });
    await shot(page, `${theme}-375-living-room`);
    await page.goto(base);
    await page.locator('.gridItem').first().waitFor();
    await shot(page, `${theme}-375-explorer`);
    await context.close();
  }
  fs.writeFileSync(`${out}/checks.json`, JSON.stringify({ errors, overflows, obstructions }, null, 2));
  console.log(JSON.stringify({ errors, overflows, obstructions }));
  assert.deepEqual(errors, []);
  assert.deepEqual(overflows, []);
  assert.deepEqual(obstructions, []);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: `${out}/test-failure.png` });
  fs.writeFileSync(`${out}/checks.json`, JSON.stringify({ errors, overflows, obstructions, failure: String(error) }, null, 2));
  console.log(JSON.stringify({ errors, overflows, obstructions, failure: String(error) }));
  throw error;
} finally { await browser.close(); }
