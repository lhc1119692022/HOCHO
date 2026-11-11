// 授权流程测试：不预先授予任何权限，模拟第一次使用。
// 验证：点「开始」→ 打开授权页（只列需要的项）→ 授权后再打开插件 → 自动开始。
// 用法：node tests/e2e/permission-flow.mjs [插件目录] [临时工作目录]
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMockServer, TEST_KEY } from './mock-server.mjs';
import { prepareExtension, launchChrome, waitUntil, sleep, createChecker } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.argv[2] || path.join(here, '..', '..'));
const WORK = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'hocho-e2e-permission'));
const PORT = 18792;
fs.mkdirSync(WORK, { recursive: true });

const { check, summary } = createChecker();
const mock = createMockServer({ port: PORT });
await mock.listen();
const ext = prepareExtension({
  src: SRC,
  dir: path.join(WORK, 'ext'),
  extraHosts: ['http://127.0.0.1/*', 'ws://127.0.0.1/*'],
});
const browser = await launchChrome({
  profile: path.join(WORK, 'profile'),
  startUrl: `http://127.0.0.1:${PORT}/page.html`,
  fakeUi: false, // 不自动同意权限提示
});
const { cdp, evaluate: ev, openTarget, findTarget, attach, bringToFront } = browser;

try {
  const { id: extId } = await cdp('Extensions.loadUnpacked', { path: ext });
  const popupUrl = `chrome-extension://${extId}/src/popup/popup.html`;
  let popup = await openTarget(popupUrl);
  await sleep(800);
  await ev(
    popup.sessionId,
    `chrome.storage.local.set({ apiKey: '${TEST_KEY}', apiBase: 'http://127.0.0.1:${PORT}' }).then(() => 1)`,
  );
  await cdp('Page.reload', {}, popup.sessionId);
  await cdp('Runtime.enable', {}, popup.sessionId);
  await sleep(1000);
  await bringToFront(`http://127.0.0.1:${PORT}/`);

  // 1) 没有权限时点「开始」
  await ev(popup.sessionId, `document.getElementById('mainBtn').click(); true`, { gesture: true });
  const permUrl = await waitUntil(
    () => browser.created.find((u) => u.includes('/src/permission/permission.html')),
    { label: '授权页', timeout: 6000 },
  );
  check('没有权限时点「开始」会打开授权页', true, permUrl.split('?')[1]);
  check('默认只申请麦克风（不要「读取所有网站」，也不要摄像头）', permUrl.endsWith('need=microphone'), permUrl);
  await sleep(300);
  check(
    '没有权限时不会去连服务器',
    !mock.log.some((e) => e.type === 'ws-handshake' && !e.query.probe),
  );

  const permTarget = await findTarget((t) => t.url.includes('/src/permission/permission.html'));
  const P = await attach(permTarget.targetId);
  await sleep(600);
  const visible = await ev(
    P,
    `[...document.querySelectorAll('.item')].filter(n => getComputedStyle(n).display !== 'none').map(n => n.dataset.perm).join(',')`,
  );
  check('授权页只显示需要的一项（真实渲染）', visible === 'microphone', visible);
  check('授权由用户点按钮触发', (await ev(P, `document.querySelector('.item[data-perm="microphone"] .act').textContent`)) === '允许');
  const pending = await ev(P, `chrome.storage.local.get('pendingAction').then(v => v.pendingAction && v.pendingAction.action)`);
  check('记下了用户想「开始」', pending === 'start');

  // 2) 用户拒绝：按钮变成「去设置」，并说明原因
  await ev(P, `document.querySelector('.item[data-perm="microphone"] .act').click(); true`, { gesture: true });
  await sleep(1200);
  const denied = await ev(P, `({ btn: document.querySelector('.item[data-perm="microphone"] .act').textContent, hint: document.getElementById('hint').textContent })`);
  check('被拒绝后给出去设置的入口和原因', denied.btn === '去设置' && denied.hint.length > 0, JSON.stringify(denied));

  // 3) 用户在设置里改成允许（这里用 CDP 授予），并改用摄像头模式
  await cdp('Browser.grantPermissions', {
    origin: `chrome-extension://${extId}`,
    permissions: ['audioCapture', 'videoCapture'],
  });
  await ev(P, `chrome.storage.local.set({ screenMode: 'camera' }).then(() => 1)`);
  await cdp('Page.reload', {}, P);
  await cdp('Runtime.enable', {}, P);
  await sleep(800);
  check(
    '授权页刷新后显示「已允许」',
    (await ev(P, `document.querySelector('.item[data-perm="microphone"] .act').textContent`)) === '已允许',
  );

  // 4) 再次打开插件：自动继续开始
  await bringToFront(`http://127.0.0.1:${PORT}/`);
  popup = await openTarget(popupUrl);
  const hs = await waitUntil(
    () => mock.log.find((e) => e.type === 'ws-handshake' && !e.query.probe && !e.rejected),
    { timeout: 15000, label: '自动开始' },
  ).catch(() => null);
  check('授权后再打开插件，自动继续开始', Boolean(hs));
  await waitUntil(() => mock.sessions[0]?.frames.camera >= 1, { timeout: 12000, label: '摄像头帧' }).catch(() => {});
  check('摄像头画面上行', (mock.sessions[0]?.frames.camera || 0) >= 1);
  check(
    '待办记录已清除',
    !(await ev(popup.sessionId, `chrome.storage.local.get('pendingAction').then(v => v.pendingAction || null)`)),
  );
  await ev(popup.sessionId, `document.getElementById('mainBtn').click(); true`, { gesture: true });
  await sleep(800);

  // 5) 所有项都已允许后，授权页不会自动关闭，而是显示完成确认，等用户自己点。
  const one = await openTarget(`chrome-extension://${extId}/src/permission/permission.html?need=microphone`);
  await sleep(2600);
  const stillOpen = await findTarget((t) => t.url.includes('permission.html?need=microphone'));
  check('全部允许后授权页不会自动关闭', Boolean(stillOpen));
  if (stillOpen) {
    check(
      '授权页显示进度与完成按钮',
      (await ev(one.sessionId, `document.getElementById('progress').textContent`)) === '麦克风 · 已允许 1 / 1 项' &&
        (await ev(one.sessionId, `document.getElementById('done').classList.contains('show')`)) &&
        (await ev(one.sessionId, `document.getElementById('finish').textContent`)) === '完成，回到网页',
    );
  }
} catch (error) {
  check('测试流程异常', false, error.stack || error.message);
} finally {
  const failed = summary();
  const noise = browser.logs.filter((l) => !/favicon|401|403|WebSocket connection/.test(l));
  if (noise.length) {
    console.log('\n---- 页面报错 ----');
    for (const l of noise.slice(0, 20)) console.log(l);
  }
  await browser.close();
  await mock.close();
  process.exit(failed ? 1 : 0);
}
