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
import { listAccountVoices, listModels } from '../shared/moss-api.js';
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
  errorPanel: $('errorPanel'),
  errorList: $('errorList'),
  errorClose: $('errorClose'),
  proactivityControl: $('proactivityControl'),
  probeBtn: $('probeBtn'),
  probeHint: $('probeHint'),
  allUrlsToggle: $('allUrlsToggle'),
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
  memoryToggle: $('memoryToggle'),
  separateToggle: $('separateToggle'),
  qualityControl: $('qualityControl'),
  modelInput: $('modelInput'),
};

const PENDING_KEY = 'pendingAction';
const PENDING_TTL_MS = 10 * 60 * 1000;
const MODE_ORDER = ['auto', 'screen', 'camera'];
const QUALITY_ORDER = ['low', 'standard', 'high'];
const PROACTIVITY_ORDER = ['quiet', 'normal', 'lively'];
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
// 不再要「读取所有网站」；那个权限只在设置里打开「所有网站自动跟随」时才申请。
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
  field.parts = Array.from({ length: 140 }, () => {
    const z = Math.random();
    return {
      a: Math.random() * Math.PI * 2,
      r0: 80 + Math.pow(Math.random(), 1.35) * 120,
      w: (0.035 + Math.random() * 0.11) * (Math.random() < 0.85 ? 1 : -1),
      s: 0.6 + z * 1.7,
      z,
      c: PALETTE[Math.random() < 0.07 ? 3 : Math.floor(Math.random() * 3)],
      p: Math.random() * Math.PI * 2,
      tilt: 0.74 + Math.random() * 0.18,
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

function drawField(now) {
  const dt = Math.min(0.05, field.last ? (now - field.last) / 1000 : 0.016) * (slowMotion ? 0.35 : 1);
  field.last = now;
  field.t += dt;
  field.lvl += (level - field.lvl) * Math.min(1, dt * 8);
  field.energy += (fieldTarget() - field.energy) * Math.min(1, dt * 2.5);

  const { ctx, dpr, cx, cy, energy } = field;
  ctx.clearRect(0, 0, el.field.width, el.field.height);

  const glow = ctx.createRadialGradient(cx, cy, 50 * dpr, cx, cy, 190 * dpr);
  glow.addColorStop(0, `rgba(108, 92, 255, ${0.08 + energy * 0.16})`);
  glow.addColorStop(0.55, `rgba(34, 195, 240, ${0.03 + energy * 0.07})`);
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, el.field.width, el.field.height);

  const speed = 0.35 + energy * 2.1;
  const swell = snap.speaking ? 14 : 5;
  for (const p of field.parts) {
    p.a += p.w * dt * speed;
    let r = p.r0 * (1 + 0.035 * Math.sin(field.t * 0.6 + p.p));
    r += energy * swell * Math.sin(field.t * 1.3 + p.p * 1.7);
    if (snap.listening && !snap.speaking) r *= 1 - field.lvl * 0.12;
    const x = cx + Math.cos(p.a) * r * dpr;
    const y = cy + Math.sin(p.a) * r * p.tilt * dpr;
    const alpha = Math.min(0.9, (0.14 + p.z * 0.42) * (0.55 + energy * 0.8));
    const size = p.s * (1 + energy * 0.45) * dpr;
    ctx.fillStyle = `rgba(${p.c[0]}, ${p.c[1]}, ${p.c[2]}, ${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
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

  // 当前页不是陪看页：说清楚，并提示怎么解决。
  const other = running ? snap.otherTab : null;
  el.otherTabHint.hidden = !other;
  if (other) {
    el.otherTabHint.textContent = `你现在看的是「${other.showing || '另一个网页'}」，不是陪看中的「${other.target || '那个网页'}」。回到那个网页，或在当前网页点一下 HOCHO 图标切过来。`;
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
  el.memoryToggle.checked = Boolean(settings.memoryEnabled);
  el.separateToggle.checked = Boolean(settings.separateMemory);
  el.separateToggle.disabled = !settings.memoryEnabled;
  el.instructionsInput.value = settings.instructions || '';
  el.modelInput.value = settings.selectedModel || LIVE_MODEL;
  paintSeg(el.qualityControl, 'quality', QUALITY_ORDER, settings.videoQuality);
  renderVoices();
  el.allUrlsToggle.checked = Boolean(settings.allUrlsFollow);
  chrome.permissions
    .contains({ origins: ['<all_urls>'] })
    .then((granted) => {
      el.allUrlsToggle.checked = Boolean(settings.allUrlsFollow) && granted;
    })
    .catch(() => {});
}

function openSettings() {
  renderSettings();
  openSheet('settings');
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
  el.connectBtn.disabled = true;
  try {
    await listModels({ apiKey: key, apiBase: settings.apiBase });
    el.keyDot.dataset.state = 'ok';
    refreshAccountVoices();
  } catch (error) {
    el.keyDot.dataset.state = 'bad';
    el.keyError.textContent = error.message;
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
  } catch {
    el.keyDot.dataset.state = 'bad';
  }
}

async function refreshAccountVoices() {
  try {
    const voices = await listAccountVoices({ apiKey: settings.apiKey, apiBase: settings.apiBase });
    settings.accountVoices = voices;
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

el.allUrlsToggle.addEventListener('change', async () => {
  if (el.allUrlsToggle.checked) {
    const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
    if (!granted) {
      // 弹窗里弹不出授权框，走授权页；授权完回来自动打开这个开关。
      el.allUrlsToggle.checked = false;
      await requestPermissions(['screen'], { action: 'all-urls' });
      return;
    }
    settings.allUrlsFollow = true;
    await saveSettings({ allUrlsFollow: true });
  } else {
    settings.allUrlsFollow = false;
    await saveSettings({ allUrlsFollow: false });
    await chrome.permissions.remove({ origins: ['<all_urls>'] }).catch(() => {});
  }
});

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

el.memoryToggle.addEventListener('change', async () => {
  settings.memoryEnabled = el.memoryToggle.checked;
  el.separateToggle.disabled = !settings.memoryEnabled;
  await saveSettings({ memoryEnabled: settings.memoryEnabled });
});
el.separateToggle.addEventListener('change', async () => {
  settings.separateMemory = el.separateToggle.checked;
  await saveSettings({ separateMemory: settings.separateMemory });
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
  if (pending.action === 'all-urls') {
    const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
    if (granted) {
      settings.allUrlsFollow = true;
      await saveSettings({ allUrlsFollow: true });
      toast('info', '已打开「所有网站自动跟随」：切换标签页时会自动跟过去。');
    }
    return;
  }
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
  settings = await loadSettings();
  const res = await toOffscreen('snapshot');
  if (res?.ok && res.snapshot) snap = { ...snap, ...res.snapshot, lines: res.snapshot.lines || [] };

  renderChat();
  renderSubtitle();
  renderSettings();
  sizeField();
  seedField();
  requestAnimationFrame(drawField);
  window.addEventListener('resize', sizeField);

  if (!settings.apiKey) {
    openSettings();
    setTimeout(() => el.apiKeyInput.focus(), 100);
    return;
  }
  checkKeySilently();
  resumePending();
  followCurrentTab();
}

// 陪伴进行中、你在另一个网页点了 HOCHO 图标：把陪看目标切到这个网页（对话不中断）。
async function followCurrentTab() {
  if (!isRunning() || settings.screenMode === 'camera') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (!tab?.id || /^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url || '')) return;
  toOffscreen('command', { cmd: 'set-target', tabId: tab.id, url: tab.url || '', title: tab.title || '' });
}

init();
