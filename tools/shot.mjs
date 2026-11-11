// 截图弹窗（主界面 + 设置页），用于人工检查排版。
// 用法：node tools/shot.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareExtension, launchChrome, sleep } from '../tests/e2e/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const WORK = path.join(os.tmpdir(), 'hocho-shot');
const OUT = path.join(ROOT, 'docs', 'screens');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const ext = prepareExtension({ src: ROOT, dir: path.join(WORK, 'ext') });
const browser = await launchChrome({ profile: path.join(WORK, 'profile') });
const { cdp, evaluate: ev, openTarget } = browser;

// 弹窗真实尺寸。测试浏览器窗口比这大得多，而 .sheet 是 position:fixed 撑满视口的，
// 所以必须先把这个页面模拟成 360×508 的视口，截出来的才是用户真正看到的样子。
const VIEW = { width: 360, height: 508 };

async function shot(sessionId, file) {
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: VIEW.width,
    height: VIEW.height,
    deviceScaleFactor: 2,
    mobile: false,
  }, sessionId);
  await sleep(250);
  const { data } = await cdp('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  }, sessionId);
  await cdp('Emulation.clearDeviceMetricsOverride', {}, sessionId).catch(() => {});
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(path.basename(file), `${VIEW.width}x${VIEW.height}`);
}

try {
  const { id: extId } = await cdp('Extensions.loadUnpacked', { path: ext });
  const popup = await openTarget(`chrome-extension://${extId}/src/popup/popup.html`);
  const P = popup.sessionId;
  await sleep(1000);

  // 填一个假 Key，让主界面正常显示（不联网校验）
  await ev(P, `chrome.storage.local.set({ apiKey: 'screenshot-placeholder' }).then(() => 1)`);
  await cdp('Page.reload', {}, P);
  await cdp('Runtime.enable', {}, P);
  await sleep(1400);

  await ev(P, `document.querySelectorAll('.sheet').forEach(s => s.classList.remove('open')); document.getElementById('scrim').hidden = true; 1`);
  await sleep(1200);
  await shot(P, path.join(OUT, 'popup-main.png'));

  await ev(P, `document.getElementById('settingsBtn').click(); 1`, { gesture: true });
  await sleep(800);
  await shot(P, path.join(OUT, 'popup-settings.png'));

  // 设置页下半部分：滚到底再截一张
  await ev(P, `(() => { const b = document.querySelector('#sheet-settings .sheet-body'); b.scrollTop = b.scrollHeight; return 1; })()`);
  await sleep(400);
  await shot(P, path.join(OUT, 'popup-settings-bottom.png'));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
