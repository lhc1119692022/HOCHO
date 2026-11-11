// 弹窗界面（v0.5）。会话跑在 offscreen 文档里，弹窗只做遥控和显示，关掉不影响会话。
//
// 权限原则：弹窗里不调用任何会弹出浏览器对话框的接口（弹出时弹窗会被关掉，流程就断了）。
// 缺权限时打开授权页（src/permission），授权完成后再点开插件会自动继续刚才的操作。

import {
  LIVE_MODEL,
  DEFAULT_INSTRUCTIONS,
  DEFAULT_PERSONA,
  PERSONA_MAX_CHARS,
  VOICE_LIBRARY_URL,
} from '../shared/defaults.js';
import { loadSettings, saveSettings, popularVoices } from '../shared/storage.js';
import { listAccountVoices, listModels, MossApiError } from '../shared/moss-api.js';
import { removeAuthRule } from '../shared/auth-rule.js';
import { probeProactiveComment } from '../live/proactive-probe.js';

const $ = (id) => document.getElementById(id);

const el = {
  charChip: $('charChip'),
  chipAvatar: $('chipAvatar'),
  chipName: $('chipName'),
  addCharacter: $('addCharacter'),
  settingsBtn: $('settingsBtn'),
  stage: $('stage'),
  field: $('field'),
  mainBtn: $('mainBtn'),
  orbAvatar: $('orbAvatar'),
  status: $('status'),
  statusText: $('statusText'),
  subtitle: $('subtitle'),
  subtitleWho: $('subtitleWho'),
  subtitleText: $('subtitleText'),
  toast: $('toast'),
  toastText: $('toastText'),
  micBtn: $('micBtn'),
  listenBtn: $('listenBtn'),
  videoTypeRow: $('videoTypeRow'),
  videoTypeSelect: $('videoTypeSelect'),
  otherTabHint: $('otherTabHint'),
  followHint: $('followHint'),
  targetSwitchHint: $('targetSwitchHint'),
  targetSwitchText: $('targetSwitchText'),
  errorPanel: $('errorPanel'),
  errorList: $('errorList'),
  errorClose: $('errorClose'),
  proactivityControl: $('proactivityControl'),
  probeBtn: $('probeBtn'),
  probeHint: $('probeHint'),
  modeSlider: $('modeSlider'),
  modeThumb: $('modeThumb'),
  scrim: $('scrim'),
  sheets: {
    characters: $('sheet-characters'),
    editor: $('sheet-editor'),
    settings: $('sheet-settings'),
  },
  characterList: $('characterList'),
  editorTitle: $('editorTitle'),
  editorAvatar: $('editorAvatar'),
  nameInput: $('nameInput'),
  personaInput: $('personaInput'),
  personaCount: $('personaCount'),
  editorVoiceSelect: $('editorVoiceSelect'),
  avatarUpload: $('avatarUpload'),
  avatarEmoji: $('avatarEmoji'),
  avatarInitial: $('avatarInitial'),
  avatarFile: $('avatarFile'),
  deleteCharacter: $('deleteCharacter'),
  saveCharacter: $('saveCharacter'),
  apiKeyInput: $('apiKeyInput'),
  apiKeyEye: $('apiKeyEye'),
  connectBtn: $('connectBtn'),
  keyDot: $('keyDot'),
  keyError: $('keyError'),
  voiceSelect: $('voiceSelect'),
  addVoiceBtn: $('addVoiceBtn'),
  openVoiceLibrary: $('openVoiceLibrary'),
  addVoiceRow: $('addVoiceRow'),
  newVoiceId: $('newVoiceId'),
  confirmVoice: $('confirmVoice'),
  instructionsToggle: $('instructionsToggle'),
  instructionsBody: $('instructionsBody'),
  instructionsInput: $('instructionsInput'),
  instructionsReset: $('instructionsReset'),
  memorySharedToggle: $('memorySharedToggle'),
  qualityControl: $('qualityControl'),
  modelInput: $('modelInput'),
  clearDataBtn: $('clearDataBtn'),
  clearDataHint: $('clearDataHint'),
};

const PENDING_KEY = 'pendingAction';
const PENDING_TTL_MS = 10 * 60 * 1000;
const MODE_ORDER = ['auto', 'screen', 'camera'];
const QUALITY_ORDER = ['low', 'standard', 'high'];
const PROACTIVITY_ORDER = ['quiet', 'normal', 'lively'];
// 她的声音比视频原声小，固定放大到这个倍数（原来做成滑块，后来去掉了）。
const DEFAULT_VOICE_VOLUME = 1.8;
const GRADIENTS = [
  ['#6c5cff', '#22c3f0'],
  ['#a66bff', '#ff7ab6'],
  ['#22c3f0', '#2fd9a2'],
  ['#ff8a5c', '#ff5fa2'],
  ['#5b7cff', '#a66bff'],
];

let settings = null;
let editing = null;
let toastTimer = null;
let snap = {
  state: 'idle',
  lines: [],
  muted: false,
  speaking: false,
  listening: false,
  tabAudio: { active: false, audible: false, transcribing: false },
  videoType: { typeId: 'general', videoKey: '' },
  otherTab: null,
  errors: [],
};
let level = 0;
let probing = false;
let preferredTabId = null;

// ==================== 工具 ====================

const activeCharacter = () =>
  settings.characters.find((c) => c.id === settings.activeCharacterId) || settings.characters[0];
const isRunning = () => ['live', 'connecting', 'reconnecting'].includes(snap.state);

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
const toBg = (type) => send({ target: 'bg', type });
const toOffscreen = (type, payload) => send({ target: 'offscreen', type, payload });

function hashIndex(text, n) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % n;
}

function paintAvatar(node, avatar, name, id) {
  node.textContent = '';
  node.classList.remove('mono');
  if (avatar?.type === 'image' && avatar.value) {
    const img = document.createElement('img');
    img.src = avatar.value;
    img.alt = '';
    node.appendChild(img);
  } else if (avatar?.type === 'emoji' && avatar.value) {
    node.textContent = avatar.value;
  } else {
    const [g1, g2] = GRADIENTS[hashIndex(id || name || '', GRADIENTS.length)];
    node.classList.add('mono');
    node.style.setProperty('--g1', g1);
    node.style.setProperty('--g2', g2);
    node.textContent = [...(name || '?').trim()][0] || '?';
  }
}

function toast(kind, text) {
  clearTimeout(toastTimer);
  el.toast.dataset.level = kind;
  el.toastText.textContent = text;
  el.toast.hidden = false;
  toastTimer = setTimeout(() => (el.toast.hidden = true), kind === 'error' ? 9000 : 4000);
}

// ==================== 权限 ====================

async function permState(name) {
  try {
    return (await navigator.permissions.query({ name })).state;
  } catch {
    return 'prompt';
  }
}

// 取“用户正在看的那一个标签页”的 tabCapture streamId。
// 授权页会短暂变成当前标签，所以打开授权页前把原来的 tabId 记下来，回来时优先用它。
async function grabTabAudio({ forMode = settings.screenMode } = {}) {
  if (forMode === 'camera' || !chrome.tabCapture?.getMediaStreamId) return null;
  try {
    let tab = null;
    if (Number.isInteger(preferredTabId)) {
      tab = await chrome.tabs.get(preferredTabId).catch(() => null);
      preferredTabId = null;
    }
    if (!tab) {
      // 弹窗在测试环境里本身也是一个标签页；跳过 chrome-extension:// 这类不能采集的页面。
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
      const tabs = await chrome.tabs
        .query(win?.id ? { windowId: win.id } : { lastFocusedWindow: true })
        .catch(() => []);
      const usable = tabs.filter((t) => t.id && !/^(chrome|edge|about|chrome-extension|devtools):/i.test(t.url || ''));
      tab = usable.find((t) => t.active) || usable.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
    }
    if (!tab?.id) return null;
    // 优先让后台取 streamId：service worker 拿到的 ID 可以交给 offscreen 消费。
    const viaBg = await send({ target: 'bg', type: 'tab-audio-stream', payload: { tabId: tab.id } });
    if (viaBg?.ok && viaBg.streamId) {
      return {
        streamId: viaBg.streamId,
        tabId: viaBg.tabId || tab.id,
        title: viaBg.title || tab.title || '',
        url: viaBg.url || tab.url || '',
      };
    }
    // 某些 Chrome 版本只允许在用户点击的扩展页面里取，弹窗里再试一次。
    const streamId = await Promise.race([
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('获取标签页声音超时')), 1200)),
    ]).catch(() => null);
    return streamId ? { streamId, tabId: tab.id, title: tab.title || '', url: tab.url || '' } : null;
  } catch {
    return null;
  }
}

// 默认只要麦克风（和摄像头模式下的摄像头）。看网页靠「点图标时对当前网页的临时授权」，
// 网页截图由当前页的 activeTab 授权覆盖，不申请所有网站权限。
async function missingFor(mode) {
  const miss = [];
  if ((await permState('microphone')) !== 'granted') miss.push('microphone');
  if ((mode === 'camera' || mode === 'auto') && (await permState('camera')) !== 'granted') {
    miss.push('camera');
  }
  return miss;
}

// 打开授权页，并记下用户想做的事，授权完成后再点开插件时自动继续。
async function requestPermissions(missing, action) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  await chrome.storage.local.set({ [PENDING_KEY]: { ...action, tabId: tab?.id ?? null, at: Date.now() } });
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`src/permission/permission.html?need=${missing.join(',')}`),
  });
  window.close();
}

// ==================== 弹层 ====================

function openSheet(name) {
  for (const [key, node] of Object.entries(el.sheets)) node.classList.toggle('open', key === name);
  el.scrim.hidden = false;
}

function closeSheets() {
  for (const node of Object.values(el.sheets)) node.classList.remove('open');
  el.scrim.hidden = true;
  closeSelect();
}

el.scrim.addEventListener('click', closeSheets);
for (const btn of document.querySelectorAll('[data-close]')) btn.addEventListener('click', closeSheets);

// ==================== 自绘下拉 ====================

let openSelect = null;

function closeSelect() {
  if (!openSelect) return;
  openSelect.menu.remove();
  openSelect.root.dataset.open = '0';
  openSelect = null;
}
document.addEventListener('click', closeSelect);

// options: [{ value, label, onRemove? }]
function buildSelect(root, options, value, onPick) {
  root.textContent = '';
  const label = document.createElement('span');
  label.className = 'select-label';
  const caret = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  caret.classList.add('chev');
  caret.innerHTML = '<use href="#i-chev"/>';
  root.append(label, caret);

  const current = options.find((o) => o.value === value) || options[0];
  label.textContent = current?.label || '';
  root.dataset.value = current?.value ?? '';

  root.onclick = (event) => {
    event.stopPropagation();
    if (openSelect?.root === root) {
      closeSelect();
      return;
    }
    closeSelect();
    const menu = document.createElement('div');
    menu.className = 'select-menu';
    for (const opt of options) {
      const item = document.createElement('div');
      item.className = 'select-opt';
      if (opt.value === root.dataset.value) item.classList.add('on');
      const text = document.createElement('span');
      text.textContent = opt.label;
      item.appendChild(text);
      if (opt.onRemove) {
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'rm';
        rm.title = '移除';
        rm.textContent = '×';
        rm.onclick = (e) => {
          e.stopPropagation();
          closeSelect();
          opt.onRemove();
        };
        item.appendChild(rm);
      }
      item.onclick = (e) => {
        e.stopPropagation();
        label.textContent = opt.label;
        root.dataset.value = opt.value;
        closeSelect();
        onPick(opt.value);
      };
      menu.appendChild(item);
    }
    root.appendChild(menu);
    root.dataset.open = '1';
    openSelect = { root, menu };
  };
}

// ==================== 粒子场 ====================

const field = {
  ctx: el.field.getContext('2d'),
  dpr: 1,
  cx: 0,
  cy: 0,
  parts: [],
  energy: 0.12,
  lvl: 0,
  t: 0,
  last: 0,
};
const PALETTE = [
  [108, 92, 255],
  [34, 195, 240],
  [166, 107, 255],
  [255, 122, 182],
];
const slowMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function sizeField() {
  const rect = el.field.getBoundingClientRect();
  const orb = el.mainBtn.getBoundingClientRect();
  field.dpr = window.devicePixelRatio || 1;
  el.field.width = Math.round(rect.width * field.dpr);
  el.field.height = Math.round(rect.height * field.dpr);
  field.cx = (orb.left + orb.width / 2 - rect.left) * field.dpr;
  field.cy = (orb.top + orb.height / 2 - rect.top) * field.dpr;
}

function seedField() {
  // 落叶：每片叶子有自己的下落速度、左右摇摆相位和旋转速度。
  // x/y 是相对画布的归一化坐标（0~1），画的时候再乘实际尺寸，窗口大小变化也不用重新播种。
  field.parts = Array.from({ length: 26 }, () => {
    const z = Math.random();
    return {
      x: Math.random(),
      y: Math.random(),
      sway: 0.02 + Math.random() * 0.05, // 左右摆动幅度
      swayPhase: Math.random() * Math.PI * 2,
      swaySpeed: 0.5 + Math.random() * 0.7,
      fallSpeed: 0.008 + z * 0.022, // 每秒下落多少（归一化）
      spin: (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 1.1),
      angle: Math.random() * Math.PI * 2,
      size: 11 + z * 15,
      z,
      c: PALETTE[Math.random() < 0.12 ? 3 : Math.floor(Math.random() * 3)],
      // 0 正对观众（最宽），1 侧对观众（最细），用来做翻面感
      flipPhase: Math.random() * Math.PI * 2,
      flipSpeed: 0.6 + Math.random() * 1.0,
      near: Math.random() < 0.55,
    };
  });
}

function fieldTarget() {
  if (!isRunning()) return 0.12;
  if (snap.state !== 'live') return 0.38 + 0.08 * Math.sin(field.t * 1.6);
  if (snap.speaking) return 0.9;
  if (snap.listening) return 0.4 + field.lvl * 0.55;
  return 0.3;
}

// 一片叶子：中间宽、两端尖的椭圆形，带两侧对称的弧度。
// widthRatio < 1 时叶片变细，用来模拟翻面。
function drawLeaf(ctx, x, y, size, angle, widthRatio, alpha, color) {
  const h = size * 0.5;
  const w = size * 0.34 * widthRatio;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha.toFixed(3)})`;
  ctx.beginPath();
  // 从叶尖开始，右侧弧线到叶柄，左侧弧线回到叶尖
  ctx.moveTo(0, -h);
  ctx.bezierCurveTo(w * 1.25, -h * 0.55, w * 1.1, h * 0.55, 0, h);
  ctx.bezierCurveTo(-w * 1.1, h * 0.55, -w * 1.25, -h * 0.55, 0, -h);
  ctx.fill();
  // 叶脉：只在叶片足够宽时才画，否则看起来是脏点
  if (widthRatio > 0.5) {
    ctx.strokeStyle = `rgba(255, 255, 255, ${(alpha * 0.45).toFixed(3)})`;
    ctx.lineWidth = Math.max(0.4, size * 0.035);
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.72);
    ctx.lineTo(0, h * 0.72);
    ctx.stroke();
  }
  ctx.restore();
}

function drawField(now) {
  const dt = Math.min(0.05, field.last ? (now - field.last) / 1000 : 0.016) * (slowMotion ? 0.35 : 1);
  field.last = now;
  field.t += dt;
  field.lvl += (level - field.lvl) * Math.min(1, dt * 8);
  field.energy += (fieldTarget() - field.energy) * Math.min(1, dt * 2.5);

  const { ctx, dpr, energy } = field;
  const W = el.field.width;
  const H = el.field.height;
  ctx.clearRect(0, 0, W, H);

  // 中心的柔光，随活跃度增强
  const glow = ctx.createRadialGradient(field.cx, field.cy, 50 * dpr, field.cx, field.cy, 200 * dpr);
  glow.addColorStop(0, `rgba(108, 92, 255, ${0.10 + energy * 0.16})`);
  glow.addColorStop(0.55, `rgba(34, 195, 240, ${0.04 + energy * 0.08})`);
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // 活跃度越高：落得稍快、摆得更大、翻面更明显、也更不透明。
  const speed = 0.55 + energy * 1.8;
  const swayBoost = 0.7 + energy * 0.9;

  for (const p of field.parts) {
    p.y += p.fallSpeed * dt * speed;
    p.swayPhase += p.swaySpeed * dt;
    p.angle += p.spin * dt * (0.5 + energy * 0.7);
    p.flipPhase += p.flipSpeed * dt * (0.6 + energy * 0.9);

    // 飘出底部就从顶部重新落下，横向随机换一个位置，避免看起来是循环。
    if (p.y > 1.12) {
      p.y = -0.12;
      p.x = Math.random();
    }

    // 说话时叶子整体向外轻推一点，像是在震动。
    const swell = snap.speaking ? 0.06 : 0.015;
    const push = energy * swell * Math.sin(field.t * 1.3 + p.swayPhase);
    const nx = p.x + Math.sin(p.swayPhase) * p.sway * swayBoost + push;
    const ny = Math.min(1.12, p.y) + push * 0.4;

    const x = nx * W;
    const y = ny * H;
    // 翻面：cos 从 -1 到 1，映射成 0.12~1 的宽度比例
    const widthRatio = 0.12 + 0.88 * Math.abs(Math.cos(p.flipPhase));
    const alpha = Math.min(0.85, (0.16 + p.z * 0.4) * (0.6 + energy * 0.7));
    const size = p.size * (1 + energy * 0.22) * dpr * (p.near ? 1 : 0.7);

    drawLeaf(ctx, x, y, size, p.angle, widthRatio, alpha, p.c);
  }
  requestAnimationFrame(drawField);
}

// ==================== 主界面 ====================

function statusText() {
  switch (snap.state) {
    case 'connecting':
      return '连接中…';
    case 'reconnecting':
      return '重连中…';
    case 'live':
      if (snap.speaking) return `${activeCharacter().name} 在说`;
      if (snap.listening) return '在听你说';
      if (snap.tabAudio?.transcribing) return '一起看 · 在听视频';
      return '陪伴中 · 轻触结束';
    case 'error':
      return '没连上 · 轻触重试';
    default:
      return '轻触开始';
  }
}

function renderChat() {
  const character = activeCharacter();
  paintAvatar(el.chipAvatar, character.avatar, character.name, character.id);
  paintAvatar(el.orbAvatar, character.avatar, character.name, character.id);
  el.chipName.textContent = character.name;

  const running = isRunning();
  el.stage.classList.toggle('live', snap.state === 'live');
  el.status.dataset.state = snap.state;
  el.statusText.textContent = statusText();
  el.mainBtn.disabled = snap.state === 'connecting';
  el.mainBtn.setAttribute('aria-label', running ? '结束' : '开始');

  el.micBtn.classList.toggle('muted', Boolean(snap.muted));
  el.micBtn.classList.toggle('live', running && !snap.muted);
  el.micBtn.title = snap.muted ? '麦克风已关' : '麦克风';

  renderListen(running);
  el.status.classList.toggle('has-errors', (snap.errors || []).length > 0);

  paintSeg(el.modeSlider, 'mode', MODE_ORDER, settings.screenMode);
}

// 「听视频」按钮：显示开关状态，以及视频音轨有没有拿到、是不是正在听。
function renderListen(running) {
  const cameraOnly = settings.screenMode === 'camera';
  const enabled = Boolean(settings.shareVideoAudio) && !cameraOnly;
  const tab = snap.tabAudio || {};
  el.listenBtn.classList.toggle('disabled', !enabled);
  el.listenBtn.classList.toggle('hearing', enabled && running && Boolean(tab.transcribing));
  let title;
  if (cameraOnly) title = '听视频：摄像头模式下不听视频';
  else if (!settings.shareVideoAudio) title = '听视频：已关闭（点一下打开）';
  else if (!running) title = '听视频：已打开，开始后视频出声就会跟着听（会额外计费）';
  else if (!tab.active) title = '听视频：没接到这个网页的声音';
  else if (tab.transcribing) title = '听视频：正在听';
  else title = '听视频：已接到视频声音，等视频出声';
  el.listenBtn.title = title;
  el.listenBtn.setAttribute('aria-label', title);

  el.videoTypeRow.hidden = !(enabled && running && tab.active);
  el.videoTypeSelect.value = snap.videoType?.typeId || 'general';

  const showFollowHint = running;
  el.followHint.hidden = !showFollowHint;
  if (showFollowHint) {
    el.followHint.textContent = '切换到其他标签页后，点击工具栏 HOCHO 图标切换陪看目标。';
  }

  const targetSwitch = snap.targetSwitch;
  const needsAudioClick = running && targetSwitch && !targetSwitch.audio;
  el.targetSwitchHint.hidden = !needsAudioClick;
  if (needsAudioClick) {
    const reason = targetSwitch.error ? `（${targetSwitch.error}）` : '';
    el.targetSwitchText.textContent = `已切到「${targetSwitch.title || '当前网页'}」，但没有接上这个网页的声音${reason}`;
  }

  // 当前页不是陪看页：说清楚，并提示怎么解决。
  const other = running ? snap.otherTab : null;
  el.otherTabHint.hidden = !other;
  if (other) {
    el.otherTabHint.textContent = `当前页不是陪看页。点一下工具栏 HOCHO 图标，就切换到「${other.showing || '当前网页'}」（对话不会断）。`;
  }
}

function renderErrors() {
  el.errorList.textContent = '';
  const errors = snap.errors || [];
  if (!errors.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '最近没有出错。';
    el.errorList.appendChild(li);
    return;
  }
  for (const entry of [...errors].reverse()) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false });
    li.append(time, document.createTextNode(entry.text));
    el.errorList.appendChild(li);
  }
}

function paintSeg(root, key, order, value) {
  const index = Math.max(0, order.indexOf(value));
  root.querySelector('.seg-thumb').style.transform = `translateX(${index * 100}%)`;
  for (const btn of root.querySelectorAll('.seg-opt')) {
    btn.classList.toggle('on', btn.dataset[key] === value);
  }
}

function renderSubtitle() {
  const last = [...(snap.lines || [])].reverse().find((l) => l.text?.trim());
  if (!last || !isRunning()) {
    el.subtitle.hidden = true;
    return;
  }
  el.subtitle.hidden = false;
  el.subtitleWho.textContent = last.role === 'user' ? '你' : activeCharacter().name;
  el.subtitleText.textContent = last.text;
}

// ==================== 开始 / 结束 ====================

async function startSession() {
  if (!settings.apiKey) {
    openSettings();
    el.apiKeyInput.focus();
    return;
  }
  const missing = await missingFor(settings.screenMode);
  if (missing.length) {
    await requestPermissions(missing, { action: 'start' });
    return;
  }

  el.toast.hidden = true;
  el.errorPanel.hidden = true;
  snap.state = 'connecting';
  snap.lines = [];
  snap.errors = [];
  snap.otherTab = null;
  renderChat();
  renderSubtitle();

  await toBg('ensure-offscreen');
  const tabAudio = await grabTabAudio();
  const res = await toOffscreen('start', {
    muted: snap.muted,
    tabAudio,
    settings: {
      apiKey: settings.apiKey,
      apiBase: settings.apiBase,
      selectedModel: settings.selectedModel || LIVE_MODEL,
      memoryEnabled: settings.memoryEnabled,
      separateMemory: settings.separateMemory,
      instructions: settings.instructions,
      videoQuality: settings.videoQuality,
      screenMode: settings.screenMode,
      shareVideoAudio: Boolean(settings.shareVideoAudio),
      // 她的声音固定放大（模型语音本身比视频原声小），不再提供滑块。
      voiceVolume: DEFAULT_VOICE_VOLUME,
      proactivityVerified: Boolean(settings.proactivityVerified),
      targetTabId: tabAudio?.tabId ?? null,
      targetUrl: tabAudio?.url || '',
      targetTitle: tabAudio?.title || '',
      characters: settings.characters,
      activeCharacterId: settings.activeCharacterId,
    },
  });
  if (!res?.ok) {
    snap.state = 'error';
    toast('error', res?.error || '启动失败');
    renderChat();
  }
}

async function stopSession() {
  await toOffscreen('stop');
  await toBg('close-offscreen');
  snap.state = 'ended';
  snap.speaking = false;
  snap.listening = false;
  renderChat();
  renderSubtitle();
}

async function setMode(mode) {
  if (mode === settings.screenMode) return;
  if (isRunning()) {
    const missing = await missingFor(mode);
    if (missing.length) {
      await requestPermissions(missing, { action: 'mode', mode });
      return;
    }
  }
  const tabAudio = isRunning() ? await grabTabAudio({ forMode: mode }) : null;
  settings.screenMode = mode;
  await saveSettings({ screenMode: mode });
  renderChat();
  if (isRunning()) toOffscreen('command', { cmd: 'set-mode', value: mode, tabAudio });
}

// ==================== 角色 ====================

function renderCharacterList() {
  el.characterList.textContent = '';
  for (const character of settings.characters) {
    const isActive = character.id === settings.activeCharacterId;
    const row = document.createElement('div');
    row.className = 'char-item';
    row.classList.toggle('on', isActive);

    const avatar = document.createElement('span');
    avatar.className = 'avatar md';
    paintAvatar(avatar, character.avatar, character.name, character.id);

    const meta = document.createElement('span');
    meta.className = 'meta';
    const name = document.createElement('b');
    name.textContent = character.name;
    const sub = document.createElement('small');
    sub.textContent = character.persona?.replace(/[#\n]+/g, ' ').trim().slice(0, 40) || '还没有人设';
    meta.append(name, sub);

    const actions = document.createElement('span');
    actions.className = 'char-actions';
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'pill use';
    use.textContent = isActive ? '使用中' : '切换';
    if (isActive) use.classList.add('static');
    else use.onclick = () => selectCharacter(character.id);
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'pill';
    edit.textContent = '编辑';
    edit.onclick = () => openEditor(character.id);
    actions.append(use, edit);

    row.append(avatar, meta, actions);
    el.characterList.appendChild(row);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'new-row';
  add.innerHTML = '<svg><use href="#i-plus"/></svg>新建角色';
  add.onclick = () => openEditor(null);
  el.characterList.appendChild(add);
}

async function selectCharacter(id) {
  if (id === settings.activeCharacterId) return;
  settings.activeCharacterId = id;
  await saveSettings({ activeCharacterId: id });
  snap.lines = [];
  closeSheets();
  renderChat();
  renderSubtitle();
  renderVoices();
  if (isRunning()) toOffscreen('command', { cmd: 'switch-character', value: id });
}

function openEditor(id) {
  const existing = id ? settings.characters.find((c) => c.id === id) : null;
  const character = existing || {
    id: `char-${crypto.randomUUID()}`,
    name: '',
    avatar: { type: 'initial' },
    persona: DEFAULT_PERSONA,
    voiceId: null,
  };
  editing = {
    id: character.id,
    isNew: !existing,
    avatar: { ...character.avatar },
    voiceId: character.voiceId || '',
    proactivity: PROACTIVITY_ORDER.includes(character.proactivity) ? character.proactivity : 'normal',
  };
  el.editorTitle.textContent = existing ? '编辑角色' : '新建角色';
  el.nameInput.value = character.name;
  el.personaInput.value = character.persona || '';
  el.deleteCharacter.hidden = !existing || settings.characters.length <= 1;
  paintSeg(el.proactivityControl, 'proactivity', PROACTIVITY_ORDER, editing.proactivity);
  renderProbeHint();
  paintEditorAvatar();
  updatePersonaCount();
  buildSelect(el.editorVoiceSelect, voiceOptions(false), editing.voiceId, (value) => {
    editing.voiceId = value;
  });
  openSheet('editor');
  if (!existing) setTimeout(() => el.nameInput.focus(), 150);
}

// ==================== 主动评论测试 ====================

function renderProbeHint(state = null, text = '') {
  el.probeHint.classList.remove('ok', 'bad');
  if (state === 'testing') {
    el.probeHint.textContent = '测试中，大约 10 秒，会消耗少量额度…';
  } else if (state === 'ok') {
    el.probeHint.classList.add('ok');
    el.probeHint.textContent = `测试通过，TA 主动说了：「${text}」。之后视频到关键处 TA 会接话。`;
  } else if (state === 'bad') {
    el.probeHint.classList.add('bad');
    el.probeHint.textContent = `测试没通过：${text} 主动评论先不生效。`;
  } else if (settings.proactivityVerified) {
    el.probeHint.textContent = '已测试通过。需要打开底部的「听视频」才会生效。';
  } else {
    el.probeHint.textContent = '还没测试。测试通过前 TA 不会主动评论。';
  }
  el.probeBtn.disabled = state === 'testing';
  el.probeBtn.textContent = settings.proactivityVerified ? '重新测试' : '测试一下';
}

async function setProactivityVerified(value) {
  settings.proactivityVerified = value;
  await saveSettings({ proactivityVerified: value });
  if (isRunning()) toOffscreen('command', { cmd: 'set-proactivity-verified', value });
}

async function runProbe() {
  if (probing) return;
  if (!settings.apiKey) {
    renderProbeHint('bad', '还没有填 API Key（设置 → API Key）。');
    return;
  }
  probing = true;
  renderProbeHint('testing');
  const result = await probeProactiveComment({
    apiKey: settings.apiKey,
    apiBase: settings.apiBase,
    model: settings.selectedModel || LIVE_MODEL,
    character: { name: el.nameInput.value.trim() || '伙伴', persona: el.personaInput.value.trim() },
  });
  // 没有在陪伴时，测试装的鉴权规则用完就撤掉；陪伴中则保留，主连接还要用。
  if (!isRunning()) await removeAuthRule().catch(() => {});
  probing = false;
  // 如果 TA 把提示原样念出来了，也算没通过。
  if (result.ok && /陪看提示|不要念出|不要复述/.test(result.text)) {
    result.ok = false;
    result.error = `TA 把提示原样念了出来（「${result.text.slice(0, 40)}」）。`;
  }
  await setProactivityVerified(Boolean(result.ok));
  renderProbeHint(result.ok ? 'ok' : 'bad', result.ok ? result.text : result.error);
}

function paintEditorAvatar() {
  paintAvatar(el.editorAvatar, editing.avatar, el.nameInput.value || '新', editing.id);
}

function updatePersonaCount() {
  el.personaCount.textContent = `${el.personaInput.value.length} / ${PERSONA_MAX_CHARS}`;
}

async function saveCharacter() {
  const name = el.nameInput.value.trim();
  if (!name) {
    el.nameInput.focus();
    return;
  }
  const character = {
    id: editing.id,
    name,
    avatar: editing.avatar,
    persona: el.personaInput.value.trim().slice(0, PERSONA_MAX_CHARS),
    voiceId: editing.voiceId || null,
    proactivity: editing.proactivity,
  };
  const index = settings.characters.findIndex((c) => c.id === character.id);
  if (index >= 0) settings.characters[index] = character;
  else settings.characters.push(character);
  await saveSettings({ characters: settings.characters });

  const wasNew = editing.isNew;
  editing = null;
  if (wasNew) {
    await selectCharacter(character.id);
    return;
  }
  if (character.id === settings.activeCharacterId && isRunning()) {
    toOffscreen('command', { cmd: 'set-voice', value: character.voiceId });
    toOffscreen('command', { cmd: 'refresh-character', value: character.id });
  }
  renderChat();
  renderVoices();
  renderCharacterList();
  openSheet('characters');
}

async function deleteCharacter() {
  if (!editing || settings.characters.length <= 1) return;
  const character = settings.characters.find((c) => c.id === editing.id);
  if (!character || !confirm(`删除「${character.name}」？`)) return;
  settings.characters = settings.characters.filter((c) => c.id !== character.id);
  const wasActive = settings.activeCharacterId === character.id;
  if (wasActive) settings.activeCharacterId = settings.characters[0].id;
  await saveSettings({ characters: settings.characters, activeCharacterId: settings.activeCharacterId });
  editing = null;
  if (wasActive && isRunning()) {
    toOffscreen('command', { cmd: 'switch-character', value: settings.activeCharacterId });
  }
  renderChat();
  renderVoices();
  renderCharacterList();
  openSheet('characters');
}

// ==================== 音色 ====================

function voiceOptions(withRemove) {
  return [
    { value: '', label: '默认音色' },
    ...popularVoices(settings).map((v) => ({
      value: v.id,
      label: v.name,
      onRemove: withRemove && v.custom ? () => removeCustomVoice(v.id) : undefined,
    })),
  ];
}

function renderVoices() {
  buildSelect(el.voiceSelect, voiceOptions(true), activeCharacter().voiceId || '', async (value) => {
    activeCharacter().voiceId = value || null;
    await saveSettings({ characters: settings.characters });
    if (isRunning()) toOffscreen('command', { cmd: 'set-voice', value });
  });
}

async function addCustomVoice() {
  const id = el.newVoiceId.value.trim();
  if (!id) {
    el.newVoiceId.focus();
    return;
  }
  // 添加前先刷新一次账号音色，避免用旧缓存的名字。
  await refreshAccountVoices();
  const known = (settings.accountVoices || []).find((v) => v.id === id);
  settings.customVoices = [
    ...(settings.customVoices || []).filter((v) => v.id !== id),
    { id, name: known?.name || `音色 ${id.slice(0, 6)}` },
  ];
  activeCharacter().voiceId = id;
  await saveSettings({ customVoices: settings.customVoices, characters: settings.characters });
  el.newVoiceId.value = '';
  el.addVoiceRow.hidden = true;
  renderVoices();
  if (isRunning()) toOffscreen('command', { cmd: 'set-voice', value: id });
}

// 音色库里的名字可能被改过（或首次添加时账号里还没有这个名字）。
// 每次渲染音色列表时，用最新拉到的账号音色把名字统一刷新一遍。
function syncVoiceNames() {
  const account = settings.accountVoices || [];
  if (!account.length) return false;
  const byId = new Map(account.map((v) => [v.id, v.name]));
  let changed = false;
  settings.customVoices = (settings.customVoices || []).map((voice) => {
    const latest = byId.get(voice.id);
    // 只在名字确实变了、且是「音色 xxx」这种占位名或旧名时替换。
    if (latest && latest !== voice.name) {
      changed = true;
      return { ...voice, name: latest };
    }
    return voice;
  });
  return changed;
}

async function removeCustomVoice(id) {
  settings.customVoices = (settings.customVoices || []).filter((v) => v.id !== id);
  for (const c of settings.characters) if (c.voiceId === id) c.voiceId = null;
  await saveSettings({ customVoices: settings.customVoices, characters: settings.characters });
  renderVoices();
}

// ==================== 设置 ====================

function renderSettings() {
  el.apiKeyInput.value = settings.apiKey || '';
  el.apiKeyInput.type = 'password';
  el.apiKeyEye.classList.remove('reveal');
  const independent = Boolean(settings.separateMemory);
  // 「记忆共享」默认勾选；取消勾选表示角色独立记忆。
  settings.memoryEnabled = true;
  settings.separateMemory = independent;
  el.memorySharedToggle.checked = !independent;
  el.instructionsInput.value = settings.instructions || '';
  el.modelInput.value = settings.selectedModel || LIVE_MODEL;
  paintSeg(el.qualityControl, 'quality', QUALITY_ORDER, settings.videoQuality);
  // 音色库里的名字可能被改过：打开设置时拉一次最新的，再渲染。
  syncVoiceNames();
  renderVoices();
  refreshAccountVoices().then(() => renderVoices());
  renderStorageInfo();
}

function openSettings() {
  renderSettings();
  openSheet('settings');
}

// ==================== 本地数据清理 ====================

// 算一下插件在本地占了多少空间：设置、对话历史、按视频存的摘要、角色头像。
async function measureStorage() {
  const all = await chrome.storage.local.get(null);
  const bytes = new Blob([JSON.stringify(all)]).size;
  const messages = Array.isArray(all.messages) ? all.messages.length : 0;
  const summaries = all.videoSummaries && typeof all.videoSummaries === 'object'
    ? Object.keys(all.videoSummaries).length
    : 0;
  return { bytes, messages, summaries };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function renderStorageInfo() {
  if (!el.clearDataHint) return;
  try {
    const { bytes, messages, summaries } = await measureStorage();
    const parts = [`占用 ${formatBytes(bytes)}`];
    if (messages) parts.push(`${messages} 条对话`);
    if (summaries) parts.push(`${summaries} 个视频的摘要`);
    el.clearDataHint.textContent = `本地已用：${parts.join(' · ')}`;
  } catch {
    el.clearDataHint.textContent = '本地已用：读取失败';
  }
}

async function clearLocalData() {
  const { bytes } = await measureStorage();
  const ok = confirm(
    `要清理本地数据吗？\n\n会清掉：对话历史、各视频的摘要、缓存的音色列表（约 ${formatBytes(bytes)}）。\n不会动：API Key、角色、设置。\n\n清理后当前这一轮对话不受影响，但下次打开就看不到之前的记录了。`,
  );
  if (!ok) return;
  await chrome.storage.local.remove(['messages', 'videoSummaries', 'videoTypeByKey', 'accountVoices', 'modelOptions', 'lastTabActivated']);
  settings.messages = [];
  settings.videoSummaries = {};
  settings.videoTypeByKey = {};
  snap.lines = [];
  snap.messages = [];
  // 让正在跑的会话也把内存里的历史清掉，否则它下次保存又把旧的写回去。
  if (isRunning()) await toOffscreen('command', { cmd: 'clear-history' });
  renderChat();
  renderSubtitle();
  await renderStorageInfo();
  toast('info', '本地数据已清理。');
}

// 点「连接」：保存并校验 Key，成功只亮一个绿点。
async function connectKey() {
  const key = el.apiKeyInput.value.trim();
  el.apiKeyInput.value = key;
  settings.apiKey = key;
  await saveSettings({ apiKey: key });
  el.keyError.hidden = true;
  if (!key) {
    el.keyDot.dataset.state = '';
    return;
  }
  el.keyDot.dataset.state = 'checking';
  el.keyDot.title = '正在检查 API Key';
  el.keyError.hidden = true;
  el.keyError.dataset.level = '';
  el.connectBtn.disabled = true;
  try {
    await listModels({ apiKey: key, apiBase: settings.apiBase });
    el.keyDot.dataset.state = 'ok';
    el.keyDot.title = 'API Key 可用';
    refreshAccountVoices();
  } catch (error) {
    if (error instanceof MossApiError && error.status === 401) {
      el.keyDot.dataset.state = 'bad';
      el.keyDot.title = 'API Key 无效或已失效';
      el.keyError.textContent = error.message;
      el.keyError.dataset.level = 'error';
    } else {
      // /v1/models 的 HTTP/CORS/网络校验失败，不等于 MOSS Live WebSocket Key 不可用。
      // Key 仍已安全保存；真正的实时权限在用户开始陪看时检查。
      el.keyDot.dataset.state = 'saved';
      el.keyDot.title = 'Key 已保存；模型列表接口未能验证，开始实时会话时再确认';
      el.keyError.textContent = 'Key 已保存，但模型列表接口暂时无法验证。这不代表实时连接失败；开始陪看时会单独检查。';
      el.keyError.dataset.level = 'warn';
    }
    el.keyError.hidden = false;
  } finally {
    el.connectBtn.disabled = false;
  }
}

async function checkKeySilently() {
  if (!settings.apiKey) return;
  try {
    await listModels({ apiKey: settings.apiKey, apiBase: settings.apiBase });
    el.keyDot.dataset.state = 'ok';
    el.keyDot.title = 'API Key 可用';
  } catch (error) {
    if (error instanceof MossApiError && error.status === 401) {
      el.keyDot.dataset.state = 'bad';
      el.keyDot.title = 'API Key 无效或已失效';
    } else {
      el.keyDot.dataset.state = 'saved';
      el.keyDot.title = 'Key 已保存；模型列表接口未能验证，开始实时会话时再确认';
    }
  }
}

async function refreshAccountVoices() {
  if (!settings.apiKey) return;
  try {
    const voices = await listAccountVoices({ apiKey: settings.apiKey, apiBase: settings.apiBase });
    settings.accountVoices = voices;
    if (syncVoiceNames()) {
      // 名字有更新：把新的名字存下来，并重画列表。
      await saveSettings({ accountVoices: voices, customVoices: settings.customVoices });
      return;
    }
    await saveSettings({ accountVoices: voices });
  } catch {
    // 只用来给按 ID 添加的音色补名字，失败无所谓
  }
}

// ==================== 事件 ====================

el.mainBtn.addEventListener('click', () => {
  if (isRunning()) stopSession();
  else startSession();
});

el.micBtn.addEventListener('click', () => {
  snap.muted = !snap.muted;
  if (isRunning()) toOffscreen('command', { cmd: 'set-muted', value: snap.muted });
  renderChat();
});

el.modeSlider.addEventListener('click', (event) => {
  const btn = event.target.closest('.seg-opt');
  if (btn) setMode(btn.dataset.mode);
});

el.listenBtn.addEventListener('click', async () => {
  if (settings.screenMode === 'camera') {
    toast('warn', '摄像头模式下不听视频。切到「屏幕」或「Auto」后可以用。');
    return;
  }
  settings.shareVideoAudio = !settings.shareVideoAudio;
  await saveSettings({ shareVideoAudio: settings.shareVideoAudio });
  if (isRunning()) toOffscreen('command', { cmd: 'set-video-audio', value: settings.shareVideoAudio });
  toast(
    'info',
    settings.shareVideoAudio
      ? '已打开听视频：视频出声时 TA 会跟着听，会额外计费。'
      : '已关闭听视频：TA 只看画面、听你说话。',
  );
  renderChat();
});

el.videoTypeSelect.addEventListener('change', () => {
  const typeId = el.videoTypeSelect.value;
  snap.videoType = { ...(snap.videoType || {}), typeId };
  if (isRunning()) toOffscreen('command', { cmd: 'set-video-type', value: typeId });
});

el.status.addEventListener('click', () => {
  el.errorPanel.hidden = !el.errorPanel.hidden;
  if (!el.errorPanel.hidden) renderErrors();
});
el.errorClose.addEventListener('click', () => {
  el.errorPanel.hidden = true;
});

el.proactivityControl.addEventListener('click', (event) => {
  const btn = event.target.closest('.seg-opt');
  if (!btn || !editing) return;
  editing.proactivity = btn.dataset.proactivity;
  paintSeg(el.proactivityControl, 'proactivity', PROACTIVITY_ORDER, editing.proactivity);
});
el.probeBtn.addEventListener('click', runProbe);
el.clearDataBtn.addEventListener('click', clearLocalData);
el.charChip.addEventListener('click', () => {
  renderCharacterList();
  openSheet('characters');
});
el.addCharacter.addEventListener('click', () => openEditor(null));
el.settingsBtn.addEventListener('click', openSettings);

el.saveCharacter.addEventListener('click', saveCharacter);
el.deleteCharacter.addEventListener('click', deleteCharacter);
el.personaInput.addEventListener('input', updatePersonaCount);
el.nameInput.addEventListener('input', () => {
  if (editing?.avatar?.type === 'initial') paintEditorAvatar();
});
el.avatarUpload.addEventListener('click', () => el.avatarFile.click());
el.avatarInitial.addEventListener('click', () => {
  editing.avatar = { type: 'initial' };
  paintEditorAvatar();
});
el.avatarEmoji.addEventListener('click', () => {
  const current = editing.avatar?.type === 'emoji' ? editing.avatar.value : '';
  const value = prompt('输入一个表情符号', current);
  if (value?.trim()) {
    editing.avatar = { type: 'emoji', value: [...value.trim()].slice(0, 2).join('') };
    paintEditorAvatar();
  }
});
el.avatarFile.addEventListener('change', async () => {
  const file = el.avatarFile.files?.[0];
  el.avatarFile.value = '';
  if (!file) return;
  try {
    editing.avatar = { type: 'image', value: await resizeImage(file, 256) };
    paintEditorAvatar();
  } catch {
    toast('error', '图片读取失败');
  }
});

el.apiKeyEye.addEventListener('click', () => {
  const reveal = el.apiKeyInput.type === 'password';
  el.apiKeyInput.type = reveal ? 'text' : 'password';
  el.apiKeyEye.classList.toggle('reveal', reveal);
});
el.connectBtn.addEventListener('click', connectKey);
el.apiKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connectKey();
});
el.apiKeyInput.addEventListener('input', () => {
  el.keyDot.dataset.state = '';
  el.keyError.hidden = true;
});

el.addVoiceBtn.addEventListener('click', () => {
  el.addVoiceRow.hidden = !el.addVoiceRow.hidden;
  if (!el.addVoiceRow.hidden) el.newVoiceId.focus();
});
el.confirmVoice.addEventListener('click', addCustomVoice);
el.newVoiceId.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addCustomVoice();
});
el.openVoiceLibrary.addEventListener('click', () => chrome.tabs.create({ url: VOICE_LIBRARY_URL }));

el.instructionsToggle.addEventListener('click', () => {
  el.instructionsBody.hidden = !el.instructionsBody.hidden;
  el.instructionsToggle.classList.toggle('open', !el.instructionsBody.hidden);
});
el.instructionsInput.addEventListener('change', async () => {
  settings.instructions = el.instructionsInput.value;
  await saveSettings({ instructions: settings.instructions });
});
el.instructionsReset.addEventListener('click', async () => {
  el.instructionsInput.value = DEFAULT_INSTRUCTIONS;
  settings.instructions = DEFAULT_INSTRUCTIONS;
  await saveSettings({ instructions: DEFAULT_INSTRUCTIONS });
});

  el.memorySharedToggle.addEventListener('change', async () => {
    settings.memoryEnabled = true;
    settings.separateMemory = !el.memorySharedToggle.checked;
    await saveSettings({ memoryEnabled: true, separateMemory: settings.separateMemory });
  });

el.qualityControl.addEventListener('click', async (event) => {
  const btn = event.target.closest('.seg-opt');
  if (!btn) return;
  settings.videoQuality = btn.dataset.quality;
  paintSeg(el.qualityControl, 'quality', QUALITY_ORDER, settings.videoQuality);
  await saveSettings({ videoQuality: settings.videoQuality });
});

el.modelInput.addEventListener('change', async () => {
  const value = el.modelInput.value.trim() || LIVE_MODEL;
  el.modelInput.value = value;
  settings.selectedModel = value;
  await saveSettings({ selectedModel: value });
});

// ==================== 来自 offscreen 的事件 ====================

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'popup') return;
  const detail = msg.detail || {};
  switch (msg.type) {
    case 'state':
      snap.state = detail.state;
      if (detail.message) {
        toast('error', detail.message);
        (snap.errors || (snap.errors = [])).push({ at: Date.now(), text: detail.message });
        if (!el.errorPanel.hidden) renderErrors();
      }
      // 重新连上、结束或出错时，「看的不是陪看页」的提示都不再适用。
      if (detail.state !== 'live') snap.otherTab = null;
      if (detail.state === 'error' || detail.state === 'ended') {
        snap.speaking = false;
        snap.listening = false;
        snap.tabAudio = { active: false, audible: false, transcribing: false };
      }
      renderChat();
      renderSubtitle();
      break;
    case 'line': {
      const lines = snap.lines || (snap.lines = []);
      const idx = lines.findIndex((l) => l.key === detail.key && l.role === detail.role);
      if (idx >= 0) lines[idx] = { ...lines[idx], ...detail };
      else lines.push(detail);
      renderSubtitle();
      break;
    }
    case 'speaking':
      snap.speaking = detail.speaking;
      renderChat();
      break;
    case 'listening':
      snap.listening = detail.speaking;
      renderChat();
      break;
    case 'tab-audio':
      snap.tabAudio = {
        active: Boolean(detail.active),
        audible: Boolean(detail.audible),
        transcribing: Boolean(detail.transcribing),
      };
      renderChat();
      break;
    case 'video-type':
      snap.videoType = { typeId: detail.typeId || 'general', videoKey: detail.videoKey || '' };
      renderChat();
      break;
    case 'target-switched':
      snap.targetSwitch = detail;
      renderChat();
      break;
    case 'other-tab':
      snap.otherTab = detail;
      renderChat();
      break;
    case 'error-log':
      (snap.errors || (snap.errors = [])).push(detail);
      if (snap.errors.length > 10) snap.errors.shift();
      if (!el.errorPanel.hidden) renderErrors();
      renderChat();
      break;
    case 'level':
      level = Math.min(1, (detail.level || 0) * 6);
      break;
    case 'notice':
      if (detail.level === 'error' || detail.level === 'warn') toast(detail.level, detail.text);
      break;
    default:
      break;
  }
});

// ==================== 启动 ====================

async function resizeImage(file, size) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas
    .getContext('2d')
    .drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  return canvas.toDataURL('image/webp', 0.9);
}

// 上次因为缺权限而中断的操作：权限到手后自动继续。
async function resumePending() {
  const { [PENDING_KEY]: pending } = await chrome.storage.local.get(PENDING_KEY);
  if (!pending) return;
  await chrome.storage.local.remove(PENDING_KEY);
  if (Date.now() - (pending.at || 0) > PENDING_TTL_MS) return;
  preferredTabId = Number.isInteger(pending.tabId) ? pending.tabId : null;
  const mode = pending.action === 'mode' ? pending.mode : settings.screenMode;
  if ((await missingFor(mode)).length) return;
  if (pending.action === 'mode') {
    if (isRunning()) await setMode(pending.mode);
    else {
      settings.screenMode = pending.mode;
      await saveSettings({ screenMode: pending.mode });
      renderChat();
    }
  } else if (!isRunning()) {
    startSession();
  }
}

async function init() {
  // 先同步把能画的画出来，避免打开瞬间一片空白（看起来像闪退）。
  sizeField();
  seedField();
  requestAnimationFrame(drawField);
  window.addEventListener('resize', sizeField);

  try {
    settings = await loadSettings();

    // 先渲染一次已知状态，再去问后台要快照；两次都渲染，用户不会看到空白。
    renderChat();
    renderSettings();

    // 快照可能因为 offscreen 还没起来而拿不到，不能让它卡住整个弹窗。
    const res = await Promise.race([
      toOffscreen('snapshot'),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    if (res?.ok && res.snapshot) snap = { ...snap, ...res.snapshot, lines: res.snapshot.lines || [] };

    renderChat();
    renderSubtitle();
    renderSettings();

    if (!settings.apiKey) {
      openSettings();
      setTimeout(() => el.apiKeyInput.focus(), 100);
      return;
    }
    checkKeySilently();
    resumePending();
    followCurrentTab();
  } catch (error) {
    // 初始化任何一步出错，也要让界面可用，而不是停在空白/半截状态。
    console.error('[HOCHO] popup init failed', error);
    renderChat();
    toast('error', `界面初始化出错：${error?.message || error}`);
  }
}

// 陪伴进行中、你在另一个网页点了 HOCHO 图标：把陪看目标切到这个网页（对话不中断）。
async function followCurrentTab() {
  if (!isRunning() || settings.screenMode === 'camera') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (!tab?.id || /^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url || '')) return;
  const result = await toOffscreen('command', {
    cmd: 'set-target',
    tabId: tab.id,
    url: tab.url || '',
    title: tab.title || '',
  });
  if (!result?.ok || !result.switched) {
    toast('warn', `切换到这个网页失败：${result?.error || '当前采集模式不支持网页切换'}`);
    return;
  }
  snap.targetSwitch = {
    title: tab.title || '当前网页',
    audio: result.audioTabId === tab.id,
    requiresClick: result.audioTabId !== tab.id,
    error: result.error || '',
  };
  if (!snap.targetSwitch.audio) {
    toast('warn', `画面目标已切换，但声音没有接上：${snap.targetSwitch.error || '浏览器未提供采集流'}`);
  }
  renderChat();
}

init();
