// HOCHO 端到端测试：本地模拟 MOSS-Live 服务器 + 无头 Chrome（假麦克风 / 摄像头，权限预先授予）。
// 用法：node tests/e2e/run-e2e.mjs [插件目录] [临时工作目录]
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { createMockServer, TEST_KEY } from './mock-server.mjs';
import { prepareExtension, launchChrome, waitUntil, sleep, createChecker } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.argv[2] || path.join(here, '..', '..'));
const WORK = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'hocho-e2e'));
const PORT = 18791;
fs.mkdirSync(WORK, { recursive: true });

const { check, summary } = createChecker();
const mock = createMockServer({ port: PORT });
await mock.listen();

const ext = prepareExtension({
  src: SRC,
  dir: path.join(WORK, 'ext'),
  extraHosts: ['http://127.0.0.1/*', 'ws://127.0.0.1/*'],
  grantAllUrls: true, // 测试副本临时加 host 权限以允许后台截图；发布 manifest 单独检查不含该权限。
});
const browser = await launchChrome({
  profile: path.join(WORK, 'profile'),
  startUrl: `http://127.0.0.1:${PORT}/page.html`,
});
const { cdp, evaluate: ev, openTarget, bringToFront } = browser;

const events = (action, session) =>
  mock.log.filter(
    (e) => e.type === 'client-event' && e.action === action && (session === undefined || e.session === session),
  );
const click = (sid, selector) =>
  ev(sid, `(() => { document.querySelector(${JSON.stringify(selector)}).click(); return true; })()`, { gesture: true });
const text = (sid, selector) => ev(sid, `document.querySelector(${JSON.stringify(selector)}).textContent.trim()`);

try {
  const { id: extId } = await cdp('Extensions.loadUnpacked', { path: ext });
  check('插件可以被加载', Boolean(extId), extId);
  const shippingManifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  check(
    '发布清单不申请所有网站权限',
    !(shippingManifest.permissions || []).includes('<all_urls>') &&
      !(shippingManifest.host_permissions || []).includes('<all_urls>') &&
      !(shippingManifest.optional_host_permissions || []).includes('<all_urls>'),
  );
  const popupUrl = `chrome-extension://${extId}/src/popup/popup.html`;
  let popup = await openTarget(popupUrl, { background: true });
  let P = popup.sessionId;
  await sleep(900);

  // ---------- 首次打开 ----------
  check(
    '还没填 Key 时，打开就是设置',
    await ev(P, `document.getElementById('sheet-settings').classList.contains('open')`),
  );
  await ev(P, `chrome.storage.local.set({ apiBase: 'http://127.0.0.1:${PORT}' }).then(() => 1)`);
  await cdp('Page.reload', {}, P);
  await cdp('Runtime.enable', {}, P);
  await sleep(1200);

  // ---------- 设置：Key ----------
  await ev(
    P,
    `(() => { document.getElementById('apiKeyInput').value = 'wrong-key'; document.getElementById('connectBtn').click(); return 1; })()`,
    { gesture: true },
  );
  const badReason = await waitUntil(
    () => ev(P, `document.getElementById('keyDot').dataset.state === 'bad' && document.getElementById('keyError').textContent`),
    { label: '错误 Key' },
  );
  check('错误的 Key：亮红点并说明原因', /无效/.test(badReason), badReason);

  await ev(
    P,
    `(() => { document.getElementById('apiKeyInput').value = '${TEST_KEY}'; document.getElementById('connectBtn').click(); return 1; })()`,
    { gesture: true },
  );
  await waitUntil(() => ev(P, `document.getElementById('keyDot').dataset.state === 'ok'`), { label: '正确 Key' });
  check('点「连接」后 Key 有效：亮绿点', await ev(P, `document.getElementById('keyDot').dataset.state === 'ok' && document.getElementById('keyError').hidden`));
  // HTTP 模型列表接口偶尔会被浏览器 CORS/网络拦截，但这不代表 WS 实时 Key 失效。
  await ev(P, `window.__hochoFetch = window.fetch; window.fetch = () => Promise.reject(new TypeError('Failed to fetch')); 1`);
  await ev(P, `document.getElementById('connectBtn').click(); 1`, { gesture: true });
  await waitUntil(() => ev(P, `document.getElementById('keyDot').dataset.state === 'saved'`), { label: 'HTTP 校验不可用时保留 Key' });
  check(
    '模型列表 Failed to fetch 不再误报 Key 失效',
    await ev(P, `document.getElementById('keyError').dataset.level === 'warn' && document.getElementById('keyError').textContent.includes('不代表实时连接失败')`),
  );
  await ev(P, `window.fetch = window.__hochoFetch; delete window.__hochoFetch; 1`);
  await ev(P, `document.getElementById('keyError').hidden = true; document.getElementById('keyDot').dataset.state = 'ok'; 1`);
  check(
    '显示 Key 的小眼睛在输入框里面',
    await ev(
      P,
      `(() => { const box = document.querySelector('.key-wrap input').getBoundingClientRect();
         const eye = document.getElementById('apiKeyEye').getBoundingClientRect();
         return eye.left > box.left && eye.right <= box.right + 1 && eye.top >= box.top - 1 && eye.bottom <= box.bottom + 1; })()`,
    ),
  );

  const order = await ev(
    P,
    `[...document.querySelectorAll('#sheet-settings .sheet-body .label')].map(l => l.textContent.trim()).join('|')`,
  );
  check(
    '设置顺序：Key → 音色 → 陪伴规则 → 记忆 → 清晰度 → 实时模型 → 本地数据',
    order === 'API Key|音色|陪伴规则|记忆|画面清晰度|实时模型|本地数据',
    order,
  );
  check(
    '清晰度和音色下拉框一样高（不是扁扁一条）',
    (await ev(P, `(() => {
      const q = document.getElementById('qualityControl').getBoundingClientRect().height;
      const v = document.getElementById('voiceSelect').getBoundingClientRect().height;
      return Math.abs(q - v) <= 4;
    })()`)),
    await ev(P, `JSON.stringify({ quality: document.getElementById('qualityControl').getBoundingClientRect().height, voice: document.getElementById('voiceSelect').getBoundingClientRect().height })`),
  );
  check(
    '设置里不再有音量滑块（不把这种控制丢给用户）',
    await ev(P, `!document.getElementById('videoVolume') && !document.getElementById('voiceVolume')`),
  );
  check(
    '设置控件不再迷你（输入框 ≥ 44px 高）',
    (await ev(P, `document.getElementById('apiKeyInput').getBoundingClientRect().height >= 44`)) &&
      (await ev(P, `parseFloat(getComputedStyle(document.querySelector('.label')).fontSize) >= 13`)),
    await ev(P, `JSON.stringify({ input: document.getElementById('apiKeyInput').getBoundingClientRect().height, label: getComputedStyle(document.querySelector('.label')).fontSize })`),
  );
  check('记忆共享默认开启', await ev(P, `document.getElementById('memorySharedToggle').checked`));
  check('实时模型默认 moss-live-1.0', (await ev(P, `document.getElementById('modelInput').value`)) === 'moss-live-1.0');
  check(
    '设置里只有一个「记忆共享」复选框，且默认勾选',
    await ev(
      P,
      `(() => {
        const field = [...document.querySelectorAll('#sheet-settings .field')].find(n => n.querySelector('#memorySharedToggle'));
        const boxes = [...field.querySelectorAll('input[type=checkbox]')];
        return boxes.length === 1 && boxes[0].parentElement.textContent.trim() === '记忆共享' && boxes[0].checked;
      })()`,
    ),
  );
  await click(P, '#memorySharedToggle');
  await waitUntil(() => ev(P, `chrome.storage.local.get(['memoryEnabled','separateMemory']).then(v => v.memoryEnabled === true && v.separateMemory === true)`), { label: '关闭记忆共享' });
  check('关闭记忆共享后按角色区分记忆', !await ev(P, `document.getElementById('memorySharedToggle').checked`));
  await click(P, '#memorySharedToggle');
  await waitUntil(() => ev(P, `chrome.storage.local.get(['memoryEnabled','separateMemory']).then(v => v.memoryEnabled === true && v.separateMemory === false)`), { label: '开启记忆共享' });
  check('开启记忆共享后所有角色共用记忆', await ev(P, `document.getElementById('memorySharedToggle').checked`));
  check(
    '清晰度：一行三段，默认标准',
    await ev(
      P,
      `(() => { const opts = [...document.querySelectorAll('#qualityControl .seg-opt')];
         const tops = new Set(opts.map(o => Math.round(o.getBoundingClientRect().top)));
         return opts.length === 3 && tops.size === 1 && document.querySelector('#qualityControl .seg-opt.on').dataset.quality === 'standard'; })()`,
    ),
  );
  check(
    '设置面板高度贴合内容，没有元素重叠',
    await ev(
      P,
      `(() => { const f = [...document.querySelectorAll('#sheet-settings .field')].map(n => n.getBoundingClientRect());
         return f.every((r, i) => i === 0 || r.top >= f[i - 1].bottom - 1); })()`,
    ),
  );

  // ---------- 设置：音色 ----------
  const voiceOptions = async () => {
    await click(P, '#voiceSelect');
    await sleep(120);
    const list = await ev(P, `[...document.querySelectorAll('#voiceSelect .select-opt span')].map(s => s.textContent)`);
    await ev(P, `document.body.click(); 1`);
    return list;
  };
  const voices = await voiceOptions();
  check('音色只有默认 + 暖暖 + 沐沐', voices.join('/') === '默认音色/暖暖 · 女声/沐沐 · 男声', voices.join('/'));
  await click(P, '#addVoiceBtn');
  await ev(P, `document.getElementById('newVoiceId').value = 'voice-clone-1'; 1`);
  await click(P, '#confirmVoice');
  await sleep(250);
  check(
    '按 ID 添加的音色出现在列表里并被选中（名字从账号音色解析）',
    (await text(P, '#voiceSelect .select-label')) === '我的克隆音色',
    await text(P, '#voiceSelect .select-label'),
  );
  await click(P, '#voiceSelect');
  await sleep(120);
  await ev(P, `document.querySelector('#voiceSelect .select-opt .rm').click(); 1`, { gesture: true });
  await sleep(200);
  check('自己添加的音色可以移除', (await voiceOptions()).length === 3);
  await click(P, '#voiceSelect');
  await sleep(120);
  await ev(
    P,
    `[...document.querySelectorAll('#voiceSelect .select-opt')].find(o => o.textContent.includes('暖暖')).click(); 1`,
    { gesture: true },
  );
  await sleep(200);
  check('可以从下拉里选回暖暖', (await text(P, '#voiceSelect .select-label')) === '暖暖 · 女声');
  await click(P, '#sheet-settings [data-close]');
  await sleep(200);

  // ---------- 主界面 ----------
  check(
    '角色名旁边直接有 ＋',
    await ev(P, `document.querySelector('.char-group').contains(document.getElementById('addCharacter'))`),
  );
  check('设置是齿轮图标', (await ev(P, `document.querySelector('#settingsBtn use').getAttribute('href')`)) === '#i-gear');
  check(
    '底部是麦克风、听视频和画面滑块',
    (await ev(P, `[...document.querySelector('.dock').children].map(n => n.id).join(',')`)) === 'micBtn,listenBtn,modeSlider',
  );
  check(
    '画面滑块顺序 Auto / 屏幕 / 摄像头，默认屏幕',
    (await ev(
      P,
      `[...document.querySelectorAll('#modeSlider .seg-opt')].map(b => b.textContent.trim() + (b.classList.contains('on') ? '*' : '')).join('/')`,
    )) === 'Auto/屏幕*/摄像头',
  );
  check('没开始时麦克风也可以点', await ev(P, `!document.getElementById('micBtn').disabled`));
  check(
    '「听视频」默认打开',
    await ev(P, `!document.getElementById('listenBtn').classList.contains('disabled')`),
    await ev(P, `document.getElementById('listenBtn').title`),
  );
  await click(P, '#listenBtn');
  await sleep(200);
  const listenOff = await ev(
    P,
    `chrome.storage.local.get('shareVideoAudio').then(v => v.shareVideoAudio === false && document.getElementById('listenBtn').classList.contains('disabled'))`,
  );
  await click(P, '#listenBtn');
  await sleep(200);
  check(
    '「听视频」可以关掉再打开',
    listenOff && (await ev(P, `chrome.storage.local.get('shareVideoAudio').then(v => v.shareVideoAudio === true)`)),
  );
  check('没开始时不显示视频类型', await ev(P, `document.getElementById('videoTypeRow').hidden`));
  await click(P, '#status');
  await sleep(100);
  check(
    '点状态文字能看出错记录',
    await ev(P, `!document.getElementById('errorPanel').hidden && document.getElementById('errorList').textContent.includes('最近没有出错')`),
  );
  await click(P, '#errorClose');
  check(
    '默认头像是名字首字，不是表情',
    await ev(P, `document.getElementById('orbAvatar').classList.contains('mono') && document.getElementById('orbAvatar').textContent === '绫'`),
  );
  check('Home 键没有循环闪烁动画', (await ev(P, `getComputedStyle(document.getElementById('mainBtn')).animationName`)) === 'none');
  check('粒子画布在绘制', await ev(P, `document.getElementById('field').width > 300`));

  // ---------- 角色 ----------
  await click(P, '#addCharacter');
  await sleep(300);
  check('点 ＋ 直接进入新建角色', (await text(P, '#editorTitle')) === '新建角色');
  const persona = await ev(P, `document.getElementById('personaInput').value`);
  const sections = ['身份背景', '核心价值观', '说话风格', '优势表现', '缺点表现', '互动原则', '限制'];
  check('人设模板包含七个方面', sections.every((s) => persona.includes(s)));
  check(
    '主动评论默认「正常」，未测试前提示不生效',
    (await text(P, '#proactivityControl .seg-opt.on')) === '正常' &&
      (await text(P, '#probeHint')).includes('还没测试'),
  );
  await click(P, '#proactivityControl [data-proactivity="lively"]');
  await click(P, '#probeBtn');
  const probeHint = await waitUntil(
    () => ev(P, `(() => { const t = document.getElementById('probeHint').textContent; return /测试通过|没通过/.test(t) && t; })()`),
    { timeout: 20000, label: '主动评论测试' },
  ).catch((e) => e.message);
  check('主动评论测试：TA 主动开口后标记为通过', String(probeHint).includes('测试通过'), probeHint);
  check(
    '测试通过后记住结果',
    await ev(P, `chrome.storage.local.get('proactivityVerified').then(v => v.proactivityVerified === true)`),
  );
  check(
    '主动评论测试发的是 commentary 请求',
    mock.log.some((e) => e.type === 'client-event' && e.action === 'session.commentary.append'),
  );
  // 测试连接已经关了；清空模拟服务器的记录，后面的检查只看真正的陪伴会话。
  await sleep(300);
  const pageProbe = mock.log.filter((e) => e.type === 'ws-handshake' && e.query?.probe === 'page');
  mock.log.length = 0;
  mock.log.push(...pageProbe);
  mock.sessions.length = 0;
  await ev(P, `document.getElementById('nameInput').value = '测试角色'; 1`);
  await click(P, '#saveCharacter');
  await sleep(400);
  check('保存后新角色成为当前角色', (await text(P, '#chipName')) === '测试角色');
  check(
    '主动评论档位存在角色上',
    await ev(
      P,
      `chrome.storage.local.get('characters').then(v => v.characters.find(c => c.name === '测试角色')?.proactivity === 'lively')`,
    ),
  );

  await click(P, '#charChip');
  await sleep(300);
  const rows = await ev(
    P,
    `[...document.querySelectorAll('#characterList .char-item')].map(r => r.querySelector('b').textContent + ':' + [...r.querySelectorAll('.pill')].map(b => b.textContent).join('+'))`,
  );
  check('角色列表每行有「切换 / 使用中」和「编辑」', rows.join(',') === '绫:切换+编辑,测试角色:使用中+编辑', rows.join(','));
  await ev(
    P,
    `[...document.querySelectorAll('#characterList .char-item')].find(r => r.textContent.includes('绫')).querySelector('.pill.use').click(); 1`,
    { gesture: true },
  );
  await sleep(300);
  check('点「切换」立即换回绫', (await text(P, '#chipName')) === '绫');
  await click(P, '#charChip');
  await sleep(250);
  await ev(
    P,
    `window.confirm = () => true;
     [...document.querySelectorAll('#characterList .char-item')].find(r => r.textContent.includes('测试角色')).querySelectorAll('.pill')[1].click(); 1`,
    { gesture: true },
  );
  await sleep(250);
  await click(P, '#deleteCharacter');
  await sleep(300);
  check('删除角色', (await ev(P, `document.querySelectorAll('#characterList .char-item').length`)) === 1);
  await click(P, '#sheet-characters [data-close]');
  await sleep(200);

  // ---------- 开始陪伴（开始前先把麦克风关掉） ----------
  await click(P, '#micBtn');
  check('开始前可以先关麦克风', await ev(P, `document.getElementById('micBtn').classList.contains('muted')`));
  await bringToFront(`http://127.0.0.1:${PORT}/`);
  await sleep(200);
  await click(P, '#mainBtn');

  const hs = await waitUntil(
    () => mock.log.find((e) => e.type === 'ws-handshake' && !e.query.probe && !e.rejected) || null,
    { timeout: 20000, label: '握手' },
  );
  check('握手带上了 Authorization', hs.auth === `Bearer ${TEST_KEY}`);
  check('握手去掉了 Origin（真实服务器见到 Origin 会返回 403）', hs.origin === null, `origin=${hs.origin}`);
  check('握手 model=moss-live-1.0', hs.query.model === 'moss-live-1.0');
  check('长期记忆默认共享（user 里不带角色 ID）', /^hocho-[0-9a-f-]+$/.test(hs.query.user || ''), hs.query.user);
  const probe = mock.log.find((e) => e.type === 'ws-handshake' && e.query.probe === 'page');
  check('普通网页连同一地址不会被带上 Key', probe && probe.auth === null, `auth=${probe?.auth}`);

  await waitUntil(() => events('mic_state', 1).length > 0, { label: 'mic_state' });
  const sequence = mock.log.filter((e) => e.type === 'client-event' && e.session === 1).map((e) => e.action);
  check(
    '配置顺序正确',
    ['attach_session', 'change_voice', 'session.update', 'media.mode', 'media.configure', 'client_context.update', 'mic_state'].every(
      (a, i) => sequence[i] === a,
    ),
    sequence.slice(0, 7).join(' → '),
  );
  check('开始前关掉的麦克风：连上后 mic_state=false', events('mic_state', 1)[0]?.msg.enabled === false);
  await click(P, '#micBtn');
  await waitUntil(() => events('mic_state', 1).some((e) => e.msg.enabled === true), { label: '开麦' });
  check('会话中重新打开麦克风', true);
  const upd = events('session.update', 1)[0]?.msg;
  check('下发人设与陪伴规则', upd?.session?.persona?.name === '绫' && upd.session.persona.prompt?.includes('身份背景'));

  await waitUntil(() => mock.current()?.greeted, { timeout: 15000, label: '音频' });
  await sleep(1200);
  const s1 = mock.sessions[0];
  const rate = s1.audioBytes / ((Date.now() - s1.firstAudioAt) / 1000);
  check('麦克风按实时速度上行（约 32000 B/s）', rate > 24000 && rate < 42000, `${Math.round(rate)} B/s`);
  await waitUntil(() => events('playback.completed', 1).length > 0, { label: 'playback.completed' });
  check(
    '语音片段播放回执完整',
    JSON.stringify(events('playback.chunk.completed', 1).map((e) => e.msg.chunk_id)) === '["1","2","3"]',
  );
  check('字幕显示最新一句', (await text(P, '#subtitleText')) === '嗨，我在呢。');

  await waitUntil(() => s1.frames.screen >= 2, { timeout: 15000, label: '屏幕帧' }).catch(() => {});
  check(
    '正在看的标签页以 0x02 前缀 JPEG 上行',
    s1.frames.screen >= 2 && Math.max(s1.lastFrame.screen?.width || 0, s1.lastFrame.screen?.height || 0) > 200,
    `${s1.frames.screen} 帧 ${JSON.stringify(s1.lastFrame.screen)}`,
  );
  check('状态显示陪伴中', (await ev(P, `document.getElementById('status').dataset.state`)) === 'live');

  // The test popup runs in a background tab; seed the initial target as the action click would.
  const originalTab = await ev(
    P,
    `chrome.tabs.query({ lastFocusedWindow: true }).then(t => t.filter(x => x.id && !/^(chrome|edge|about|chrome-extension|devtools):/i.test(x.url || '')).find(x => x.active) || null)`,
  );
  const originalTabId = originalTab?.id;
  await ev(
    P,
    `chrome.runtime.sendMessage({ target: 'offscreen', type: 'command', payload: { cmd: 'set-target', tabId: ${originalTabId}, url: ${JSON.stringify(originalTab?.url || '')}, title: ${JSON.stringify(originalTab?.title || '')} } })`,
  );
  await waitUntil(
    () => ev(P, `chrome.runtime.sendMessage({ target: 'offscreen', type: 'debug-target' }).then(v => v.targetTabId === ${originalTabId})`),
    { label: '设置初始陪看目标' },
  );

  // ---------- 切页必须手动点击 HOCHO 图标 ----------
  const followTabId = await ev(
    P,
    `chrome.tabs.create({ url: 'http://127.0.0.1:${PORT}/page.html?manual-follow=1', active: true }).then(t => t.id)`,
  );
  await sleep(1200);
  const pausedState = await ev(P, `chrome.runtime.sendMessage({ target: 'offscreen', type: 'debug-target' })`);
  check('切到新标签不会自动更换陪看目标', pausedState?.targetTabId === originalTabId, JSON.stringify(pausedState));
  check('切换标签后暂停旧页音轨，避免串入旧视频声', pausedState?.audioTabId == null, JSON.stringify(pausedState));
  check(
    '新页面 HOCHO 图标悬停提示手动切换',
    await ev(P, `chrome.action.getTitle({ tabId: ${followTabId} }).then(t => t.includes('点击切换陪看目标'))`),
  );

  // 新标签已激活后重新打开弹窗，弹窗初始化按当前页触发手动切换。
  await cdp('Page.reload', {}, P);
  await cdp('Runtime.enable', {}, P);
  const manualState = await waitUntil(
    () => ev(P, `chrome.runtime.sendMessage({ target: 'offscreen', type: 'debug-target' }).then(v => v.targetTabId === ${followTabId} ? v : null)`),
    { timeout: 10000, interval: 100, label: '点击图标后的手动切换' },
  ).catch(() => null);
  check('打开当前页 HOCHO 后切换陪看目标', manualState?.targetTabId === followTabId, JSON.stringify(manualState));
  check(
    '切换失败时提示当前网页声音未接入',
    await ev(P, `document.getElementById('targetSwitchHint').hidden || document.getElementById('targetSwitchText').textContent.includes('没有接上')`),
  );

  await ev(P, `chrome.tabs.update(${originalTabId}, { active: true }).then(() => 1)`);
  await sleep(300);
  await cdp('Page.reload', {}, P);
  await cdp('Runtime.enable', {}, P);
  await waitUntil(
    () => ev(P, `chrome.runtime.sendMessage({ target: 'offscreen', type: 'debug-target' }).then(v => v.targetTabId === ${originalTabId})`),
    { timeout: 10000, interval: 100, label: '手动切回原页面' },
  );
  await ev(P, `chrome.tabs.remove(${followTabId}).catch(() => {})`);
  await sleep(300);

  // ---------- 图标角标：一眼看出这个网页有没有在生效 ----------
  const tabId = await ev(P, `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(t => t[0].id)`);
  const badge = await ev(
    P,
    `chrome.action.getBadgeText({ tabId: ${tabId} }).then(t => ({ text: t, color: chrome.action.getBadgeBackgroundColor({ tabId: ${tabId} }).then(c => c) }))`,
  );
  check('陪看中的网页：图标显示绿点', badge.text === '●', JSON.stringify(badge));
  const otherTabId = await ev(
    P,
    `chrome.tabs.create({ url: 'https://example.com/other', active: false }).then(t => t.id)`,
  );
  const otherBadge = await waitUntil(
    () => ev(P, `chrome.action.getBadgeText({ tabId: ${otherTabId} }).then(t => (t ? t : null))`),
    { timeout: 6000, label: '别的网页的角标' },
  ).catch(() => '');
  check('别的网页：图标显示黄点（说明这个页面没生效）', otherBadge === '●', otherBadge);
  const otherColor = await ev(P, `chrome.action.getBadgeBackgroundColor({ tabId: ${otherTabId} })`);
  // Chrome 返回的是 RGBA 数组；#E5A23B = [229,162,59,255]
  check(
    '别的网页的角标是黄色',
    JSON.stringify(otherColor) === JSON.stringify([229, 162, 59, 255]),
    JSON.stringify(otherColor),
  );
  await ev(P, `chrome.tabs.remove(${otherTabId})`);

  // ---------- 关掉弹窗，会话继续 ----------
  await cdp('Target.closeTarget', { targetId: popup.targetId });
  const before = s1.audioBytes;
  await sleep(2500);
  check('关掉弹窗后会话不中断', s1.audioBytes > before + 40000, `${before} → ${s1.audioBytes}`);
  popup = await openTarget(popupUrl);
  P = popup.sessionId;
  await sleep(1300);
  check(
    '重新打开弹窗恢复陪伴中',
    (await ev(P, `document.getElementById('status').dataset.state`)) === 'live',
    await text(P, '#statusText'),
  );

  // ---------- 打断 ----------
  s1.playScenario('interrupt');
  await waitUntil(() => events('playback.stopped', 1).length > 0, { timeout: 8000, label: 'playback.stopped' });
  const stopped = events('playback.stopped', 1)[0]?.msg;
  check('被打断时回执 playback.stopped', stopped?.run_id === 'r2' && stopped.played_audio_ms >= 0, JSON.stringify(stopped));

  // ---------- 画面模式 ----------
  await click(P, '#modeSlider .seg-opt[data-mode="camera"]');
  await waitUntil(() => s1.frames.camera >= 1, { timeout: 15000, label: '摄像头帧' }).catch(() => {});
  check('切到摄像头：以 0x01 前缀上行', s1.frames.camera >= 1, `${s1.frames.camera} 帧`);
  check('切到摄像头：屏幕画面停止', events('video.state', 1).some((e) => e.msg.source === 'screen' && e.msg.enabled === false));
  await click(P, '#modeSlider .seg-opt[data-mode="auto"]');
  await waitUntil(() => events('video.stream_focus', 1).some((e) => e.msg.source === 'auto'), { timeout: 8000, label: 'auto' }).catch(() => {});
  check('Auto：主画面交给服务端（stream_focus=auto）', events('video.stream_focus', 1).some((e) => e.msg.source === 'auto'));

  // ---------- 结束 ----------
  await click(P, '#mainBtn');
  await waitUntil(() => mock.log.find((e) => e.type === 'ws-closed'), { timeout: 6000, label: '关闭' });
  check('结束时正常关闭连接（1000）', mock.log.find((e) => e.type === 'ws-closed')?.code === 1000);
  await sleep(500);
  check('结束后界面复位', (await text(P, '#statusText')) === '轻触开始');
  check('没有格式错误的二进制包', mock.sessions.every((s) => s.badPackets === 0));
} catch (error) {
  check('测试流程异常', false, error.stack || error.message);
} finally {
  const failed = summary();
  const noise = browser.logs.filter((l) => !/favicon|401|403|WebSocket connection/.test(l));
  if (noise.length) {
    console.log('\n---- 页面报错 ----');
    for (const l of noise.slice(0, 20)) console.log(l);
  }
  fs.writeFileSync(path.join(WORK, 'mock-log.json'), JSON.stringify(mock.log, null, 1));
  await browser.close();
  await mock.close();
  process.exit(failed ? 1 : 0);
}
