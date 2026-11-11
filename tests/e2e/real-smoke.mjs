// 真实服务器冒烟测试：用真的 MOSS-Live 跑一遍完整插件（会消耗少量额度）。
// 用法：MOSS_API_KEY=你的Key node tests/e2e/real-smoke.mjs
// 可选：HOCHO_SPEECH_WAV=一段说话的 WAV（前面留几秒静音），用它当麦克风，验证完整的一轮对话。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { prepareExtension, launchChrome, waitUntil, sleep, createChecker } from './harness.mjs';

const KEY = process.env.MOSS_API_KEY;
if (!KEY) {
  console.log('跳过：没有设置 MOSS_API_KEY');
  process.exit(0);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(path.join(here, '..', '..'));
const WORK = path.join(os.tmpdir(), 'hocho-real-smoke');
const PORT = 18793;
fs.mkdirSync(WORK, { recursive: true });

// 一个会变化的网页，充当“用户正在看的标签页”
const page = `<!doctype html><meta charset=utf-8><title>一起看</title><body style="margin:0;background:#123">
<canvas id=c width=900 height=500></canvas><script>
const c=document.getElementById('c').getContext('2d');let i=0;
setInterval(()=>{i++;c.fillStyle='hsl('+(i*4%360)+',55%,42%)';c.fillRect(0,0,900,500);
c.fillStyle='#fff';c.font='52px sans-serif';c.fillText('一只橘猫在弹钢琴 '+i,50,260);},150);
</script>`;
const server = http.createServer((_q, s) => {
  s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  s.end(page);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const { check, summary } = createChecker();
const ext = prepareExtension({ src: SRC, dir: path.join(WORK, 'ext'), grantAllUrls: true });
const SPEECH = process.env.HOCHO_SPEECH_WAV;
const browser = await launchChrome({
  profile: path.join(WORK, 'profile'),
  startUrl: `http://127.0.0.1:${PORT}/`,
  extraArgs: SPEECH ? [`--use-file-for-fake-audio-capture=${SPEECH}%noloop`] : [],
});
const { cdp, evaluate: ev, openTarget, findTarget, attach, bringToFront } = browser;

const serverEvents = [];
let sentBinary = 0;

try {
  const { id: extId } = await cdp('Extensions.loadUnpacked', { path: ext });
  const popup = await openTarget(`chrome-extension://${extId}/src/popup/popup.html`);
  const P = popup.sessionId;
  await sleep(800);
  await ev(P, `chrome.storage.local.set({ apiKey: ${JSON.stringify(KEY)} }).then(() => 1)`);
  await cdp('Page.reload', {}, P);
  await cdp('Runtime.enable', {}, P);
  await sleep(1200);
  check('Key 校验通过（绿点）', (await ev(P, `document.getElementById('keyDot').dataset.state`)) === 'ok');

  // 先建好 offscreen，挂上网络监听，看服务器真实返回
  await ev(P, `chrome.runtime.sendMessage({ target: 'bg', type: 'ensure-offscreen' }).then(() => 1)`);
  await sleep(300);
  const off = await findTarget((t) => t.url.includes('/src/offscreen/offscreen.html'));
  const O = await attach(off.targetId);
  // 在 offscreen 里包装 WebSocket，记录服务器发来的每条事件和上行的二进制包数
  await ev(
    O,
    `(() => {
       window.__hocho = { events: [], sent: [], sentBinary: 0, recvBinary: 0 };
       const Native = WebSocket;
       window.WebSocket = class extends Native {
         constructor(...a) {
           super(...a);
           this.addEventListener('message', (e) => {
             if (typeof e.data === 'string') { try { window.__hocho.events.push(JSON.parse(e.data)); } catch {} }
             else window.__hocho.recvBinary += 1;
           });
           this.addEventListener('open', () => (window.__hocho.opened = true));
           this.addEventListener('close', (e) => (window.__hocho.closed = e.code));
         }
         send(d) {
           if (typeof d !== 'string') window.__hocho.sentBinary += 1;
           else { try { window.__hocho.sent.push(JSON.parse(d).action); } catch {} }
           return super.send(d);
         }
       };
       return 1;
     })()`,
  );

  await bringToFront(`http://127.0.0.1:${PORT}/`);
  await sleep(200);
  await ev(P, `document.getElementById('mainBtn').click(); true`, { gesture: true });
  await waitUntil(() => ev(P, `document.getElementById('status').dataset.state === 'live'`), {
    timeout: 20000,
    label: '陪伴中',
  }).catch(() => {});
  const state = await ev(P, `({ s: document.getElementById('status').dataset.state, toast: document.getElementById('toast').hidden ? '' : document.getElementById('toastText').textContent })`);
  check('真实服务器：状态变成陪伴中', state.s === 'live', JSON.stringify(state));

  if (SPEECH) {
    // 等模型听完、回答完、并且本地播放完
    await waitUntil(
      async () => {
        const d = JSON.parse(await ev(O, `JSON.stringify(window.__hocho)`));
        return d.sent.includes('playback.completed') || d.events.some((e) => e.action === 'error');
      },
      { timeout: 45000, interval: 500, label: '一轮对话' },
    ).catch(() => {});
  } else {
    await sleep(9000);
  }
  const probe = await ev(O, `JSON.stringify(window.__hocho)`);
  const data = JSON.parse(probe);
  serverEvents.push(...data.events);
  sentBinary = data.sentBinary;
  const actions = serverEvents.map((e) => e.action);
  check('收到 session_attached', actions.includes('session_attached'));
  check('音色设置成功（voice_changed）', actions.includes('voice_changed'));
  const updated = serverEvents.find((e) => e.action === 'session.updated');
  check('人设配置成功（session.updated.error 为空）', updated && updated.data?.error === '', JSON.stringify(updated?.data));
  check('媒体配置成功（media.configured）', actions.includes('media.configured'));
  const errors = serverEvents.filter((e) => e.action === 'error');
  check('服务器没有返回任何 error', errors.length === 0, JSON.stringify(errors.map((e) => e.data?.error)));
  check('音频和画面在持续上行', sentBinary > 150, `${sentBinary} 个二进制包`);
  const still = await ev(P, `document.getElementById('status').dataset.state`);
  check('连接保持稳定', still === 'live', still);
  if (SPEECH) {
    const heard = serverEvents.filter((e) => e.action === 'input.transcript.done').map((e) => e.data?.text);
    const said = serverEvents.filter((e) => e.action === 'output.transcript.done').map((e) => e.data?.text);
    check('模型听到了用户说的话', heard.length > 0, heard.join(' / '));
    check('模型用语音回答了', said.length > 0 && data.recvBinary > 0, `${said.join(' / ')}（${data.recvBinary} 段语音）`);
    check('播放回执：逐段 + 整段完成', data.sent.includes('playback.chunk.completed') && data.sent.includes('playback.completed'));
    const sub = await ev(P, `document.getElementById('subtitle').hidden ? '' : document.getElementById('subtitleText').textContent`);
    check('弹窗字幕显示了对话', sub.length > 0, sub);
  }
  console.log('服务器事件：', [...new Set(actions)].join(', '));

  await ev(P, `document.getElementById('mainBtn').click(); true`, { gesture: true });
  await sleep(1200);
  check('结束后复位', (await ev(P, `document.getElementById('status').dataset.state`)) === 'ended');
} catch (error) {
  check('测试流程异常', false, error.stack || error.message);
} finally {
  const failed = summary();
  await browser.close();
  server.close();
  setTimeout(() => process.exit(failed ? 1 : 0), 1200);
}
