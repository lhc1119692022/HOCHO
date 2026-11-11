// offscreen 文档：会话真正运行的地方。弹窗关掉也不会中断。
//
// 注意：offscreen 只有 chrome.runtime，没有 storage / declarativeNetRequest，
// 所以设置读写、鉴权规则注入都通过 background 代理（见 shared/bg-bridge.js）。
// 这里把会话事件广播给弹窗，并保留一份内存快照，弹窗重新打开时用来恢复显示。

import { CompanionSession } from '../live/session.js';
import { loadSettingsFromBg, saveSettingsToBg } from '../shared/bg-bridge.js';

let session = null;
let settings = null;

const snapshot = {
  state: 'idle',
  message: '',
  muted: false,
  speaking: false,
  listening: false,
  sources: { screen: false, camera: false },
  tabAudio: { active: false, audible: false, transcribing: false },
  videoType: { typeId: 'general', videoKey: '' },
  otherTab: null,
  lines: [],
  messages: [],
  // 最近的连接/权限错误，弹窗里点状态文字可以查看
  errors: [],
};

function broadcast(type, detail) {
  chrome.runtime.sendMessage({ target: 'popup', type, detail }).catch(() => {});
}

function recordError(text) {
  if (!text) return;
  const entry = { at: Date.now(), text: String(text) };
  snapshot.errors.push(entry);
  if (snapshot.errors.length > 10) snapshot.errors.shift();
  broadcast('error-log', entry);
}

function pushLine(line) {
  const index = snapshot.lines.findIndex((l) => l.key === line.key && l.role === line.role);
  if (index >= 0) snapshot.lines[index] = { ...snapshot.lines[index], ...line };
  else snapshot.lines.push(line);
  if (snapshot.lines.length > 20) snapshot.lines.shift();
}

async function ensureSettings() {
  if (!settings) settings = await loadSettingsFromBg();
  return settings;
}

function wire(s) {
  s.addEventListener('state', (e) => {
    snapshot.state = e.detail.state;
    snapshot.message = e.detail.message || '';
    if (e.detail.state === 'error') recordError(e.detail.message || '连接失败');
    if (e.detail.state === 'reconnecting') recordError(`连接断开，正在第 ${e.detail.attempt || 1} 次重连`);
    if (e.detail.state === 'error' || e.detail.state === 'ended') {
      snapshot.sources = { screen: false, camera: false };
      snapshot.speaking = false;
      snapshot.listening = false;
      snapshot.tabAudio = { active: false, audible: false, transcribing: false };
    }
    broadcast('state', e.detail);
  });
  s.addEventListener('transcript', (e) => {
    pushLine(e.detail);
    broadcast('line', e.detail);
  });
  s.addEventListener('message', (e) => {
    const index = snapshot.messages.findIndex((m) => m.id === e.detail.id);
    if (index >= 0) snapshot.messages[index] = { ...snapshot.messages[index], ...e.detail };
    else snapshot.messages.push(e.detail);
    if (snapshot.messages.length > 500) snapshot.messages.shift();
    broadcast('message', e.detail);
  });
  s.addEventListener('assistant-speaking', (e) => {
    snapshot.speaking = e.detail.speaking;
    broadcast('speaking', e.detail);
  });
  s.addEventListener('user-speaking', (e) => {
    snapshot.listening = e.detail.speaking;
    broadcast('listening', e.detail);
  });
  s.addEventListener('mic-level', (e) => broadcast('level', e.detail));
  s.addEventListener('sources', () => {
    snapshot.sources = s.sourceState();
    broadcast('sources', snapshot.sources);
  });
  s.addEventListener('tab-audio', (e) => {
    snapshot.tabAudio = e.detail;
    broadcast('tab-audio', e.detail);
  });
  s.addEventListener('video-type', (e) => {
    snapshot.videoType = e.detail;
    broadcast('video-type', e.detail);
  });
  s.addEventListener('other-tab', (e) => {
    snapshot.otherTab = e.detail;
    broadcast('other-tab', e.detail);
  });
  s.addEventListener('notice', (e) => {
    if (e.detail.level === 'error' || e.detail.level === 'warn') recordError(e.detail.text);
    broadcast('notice', e.detail);
  });
}

async function start(payload) {
  // 每次启动重新读取，确保带出上次持久化的 messages / sessionId。
  const current = await loadSettingsFromBg();
  settings = { ...current, ...payload.settings };
  if (payload.settings) {
    // targetTabId / targetUrl / targetTitle 是本次采集的临时参数，不落盘。
    const { targetTabId, targetUrl, targetTitle, ...persisted } = payload.settings;
    await saveSettingsToBg(persisted);
  }
  const character =
    settings.characters.find((c) => c.id === settings.activeCharacterId) || settings.characters[0];

  if (session) await session.stop();
  session = new CompanionSession({
    settings,
    character,
    muted: payload.muted,
    tabAudio: payload.tabAudio || null,
  });
  snapshot.lines = [];
  snapshot.messages = Array.isArray(settings.messages) ? settings.messages.slice(-200) : [];
  snapshot.muted = Boolean(payload.muted);
  snapshot.speaking = false;
  snapshot.listening = false;
  snapshot.sources = { screen: false, camera: false };
  snapshot.tabAudio = { active: false, audible: false, transcribing: false };
  snapshot.videoType = { typeId: 'general', videoKey: '' };
  snapshot.otherTab = null;
  snapshot.errors = [];
  wire(session);

  await session.start().catch(() => {
    // 错误通过 state 事件广播。
  });
}

async function stop() {
  if (!session) return;
  await session.stop();
  session = null;
  snapshot.state = 'ended';
  snapshot.tabAudio = { active: false, audible: false, transcribing: false };
}

async function command(payload) {
  await ensureSettings();
  switch (payload.cmd) {
    case 'set-muted':
      session?.setMuted(payload.value);
      snapshot.muted = payload.value;
      break;
    case 'set-mode':
      settings.screenMode = payload.value;
      await saveSettingsToBg({ screenMode: payload.value });
      await session?.setScreenMode(payload.value, payload.tabAudio || null);
      break;
    case 'set-target':
      await session?.switchTarget(payload.tabId, payload.url, payload.title);
      break;
    case 'set-video-audio':
      session?.setShareVideoAudio(Boolean(payload.value));
      break;
    case 'set-video-type':
      session?.setVideoType(payload.value);
      break;
    case 'refresh-character': {
      // 角色编辑里改了主动评论档位等，正在用的角色立刻生效（不重连）。
      settings = await loadSettingsFromBg();
      const character = settings.characters.find((c) => c.id === payload.value);
      if (session && character && session.character?.id === character.id) session.character = character;
      break;
    }
    case 'set-proactivity-verified':
      settings.proactivityVerified = Boolean(payload.value);
      await saveSettingsToBg({ proactivityVerified: settings.proactivityVerified });
      session?.setProactivityVerified(settings.proactivityVerified);
      break;
    case 'switch-character': {
      settings = await loadSettingsFromBg();
      settings.activeCharacterId = payload.value;
      const character =
        settings.characters.find((c) => c.id === payload.value) || settings.characters[0];
      snapshot.lines = [];
      await session?.switchCharacter(character);
      break;
    }
    case 'set-voice':
      session?.setVoice(payload.value);
      break;
    default:
      break;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return undefined;

  (async () => {
    try {
      switch (msg.type) {
        case 'snapshot':
          sendResponse({ ok: true, snapshot });
          break;
        case 'start':
          await start(msg.payload);
          sendResponse({ ok: true });
          break;
        case 'stop':
          await stop();
          sendResponse({ ok: true });
          break;
        case 'command':
          await command(msg.payload);
          sendResponse({ ok: true });
          break;
        case 'tab-activated':
          await session?.switchTarget(msg.payload?.tabId, msg.payload?.url, msg.payload?.title);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: `未知请求 ${msg.type}` });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();
  return true;
});
