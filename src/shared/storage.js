// 本地设置存储。API Key 等数据只保存在 chrome.storage.local。

import {
  BUILTIN_VOICES,
  DEFAULT_API_BASE,
  DEFAULT_CHARACTERS,
  DEFAULT_INSTRUCTIONS,
  DEFAULT_SCREEN_MODE,
} from './defaults.js';

export const SETTINGS_VERSION = 8;

// 之前版本的默认陪伴规则。升级时如果用户没改过，就换成新默认。
const LEGACY_INSTRUCTIONS = `你在浏览器插件里陪用户一起看网页、刷视频，用语音聊天。
- 你看得到用户分享的页面和画面。像朋友坐在旁边一起看那样自然地聊，可以简短评论或接话，但不要逐条描述画面，也不要复述页面文字。
- 用户没说话时以安静陪伴为主，只在合适的时候偶尔搭一句。
- 说话口语化、简短，一般一到三句。看不清就直接说不确定，不要编造。`;

// 0.6.0 早期版本：曾把视频声音直接混进麦克风上行；这个默认提示词也要替换掉。
const V4_INSTRUCTIONS = `你在浏览器插件里陪用户一起看网页、刷视频，用语音聊天。
- 你看得到用户分享的页面和画面，也听得到标签页里正在播放的视频声音。像朋友坐在旁边一起看那样自然地聊，可以简短评论或接话；视频到关键处（剧情、笑点、台词、音乐变化）可以主动搭一句，但不要从头到尾解说，也不要复述画面或字幕。
- 用户没说话时以安静陪伴为主，只在合适的时候偶尔搭一句。
- 说话口语化、简短，一般一到三句。看不清、听不清就直接说不确定，不要编造。`;

function defaults() {
  return {
    version: SETTINGS_VERSION,
    apiKey: '',
    apiBase: DEFAULT_API_BASE,
    sessionId: '',
    voiceEnabled: true,
    // 「听视频」：默认打开，视频真的出声时才建立第二条连接（会额外计费）
    shareVideoAudio: true,
    // 她的声音固定放大倍数（模型语音本身比视频原声小）。不提供给用户调，避免多一个看不懂的选项。
    voiceVolume: 1.8,
    // 按视频网址记住：手动选的视频类型、视频内容摘要
    videoTypeByKey: {},
    videoSummaries: {},
    // 主动评论：档位存在每个角色上；在角色编辑里点「测试」通过后才生效
    proactivityVerified: false,
    messages: [],
    selectedModel: '',
    modelOptions: [],
    installId: '',
    // 记忆：默认共享。separateMemory=true 时每个角色各自独立。
    memoryEnabled: true,
    separateMemory: false,
    instructions: DEFAULT_INSTRUCTIONS,
    videoQuality: 'standard',
    screenMode: DEFAULT_SCREEN_MODE,
    characters: structuredClone(DEFAULT_CHARACTERS),
    activeCharacterId: DEFAULT_CHARACTERS[0].id,
    // 用户按音色 ID 手动添加的音色
    customVoices: [],
    // 从接口拉到的账号音色，仅用于解析名称，不作为列表展示
    accountVoices: [],
  };
}

function storedVersion(stored) {
  // 全新安装的 storage 是空的，不应按 0.1 的旧行为迁移成“角色独立记忆”。
  if (stored.version != null) return stored.version;
  return Object.keys(stored).length > 0 ? 1 : SETTINGS_VERSION;
}

function migrate(stored) {
  const settings = { ...defaults(), ...stored };
  const from = storedVersion(stored);
  // 0.1.0：旧版按角色隔离记忆，新版默认共享。
  if (from < 2) {
    settings.separateMemory = true; // 尊重旧的“按角色独立”行为，用户可关闭
    settings.customVoices = [];
    settings.modelOptions = [];
    settings.selectedModel = '';
  }
  // 0.5.0：预设角色的月亮表情头像换成首字头像。
  if (from < 3 && Array.isArray(settings.characters)) {
    settings.characters = settings.characters.map((c) =>
      c.id === 'preset-ling' && c.avatar?.type === 'emoji' && c.avatar.value === '🌙'
        ? { ...c, avatar: { type: 'initial' } }
        : c,
    );
  }
  // 0.6.x：默认陪伴规则增加“知道视频在说什么、关键处主动接话”。
  if (from < 5 && (settings.instructions === LEGACY_INSTRUCTIONS || settings.instructions === V4_INSTRUCTIONS)) {
    settings.instructions = DEFAULT_INSTRUCTIONS;
  }
  // 0.7.0：「听视频」正式加入弹窗，默认打开（之前的版本在弹窗里被强制关掉并存了下来）。
  if (from < 6) settings.shareVideoAudio = true;
  // 0.7.2：发现她的声音明显比视频原声小。之前统一存成 1，这里改成新的默认提升值。
  // 只在用户没动过（正好是 1）时才改，避免覆盖用户自己调过的音量。
  if (from < 7 && Number(settings.voiceVolume) === 1) settings.voiceVolume = 1.8;
  settings.version = SETTINGS_VERSION;
  return settings;
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get(null);
  const from = storedVersion(stored);
  const settings = migrate(stored);
  if (!Array.isArray(settings.characters) || settings.characters.length === 0) {
    settings.characters = structuredClone(DEFAULT_CHARACTERS);
  }
  if (!settings.characters.some((c) => c.id === settings.activeCharacterId)) {
    settings.activeCharacterId = settings.characters[0].id;
  }
  if (!settings.installId) settings.installId = crypto.randomUUID();
  if (stored.version !== SETTINGS_VERSION || !stored.installId) {
    const patch = {
      installId: settings.installId,
      version: SETTINGS_VERSION,
      characters: settings.characters,
    };
    // 迁移结果也要落盘，否则下次读到旧版本字段又会重新套用默认值。
    if (from < 2) patch.separateMemory = settings.separateMemory;
    if (from < 5 && settings.instructions === DEFAULT_INSTRUCTIONS) {
      patch.instructions = DEFAULT_INSTRUCTIONS;
    }
    if (from < 6) patch.shareVideoAudio = true;
    if (from < 7) patch.voiceVolume = settings.voiceVolume;
    await chrome.storage.local.set(patch);
    // 已删除功能留下的字段
    await chrome.storage.local.remove(['relayUrl', 'sourceMode', 'proactivity', 'cameraEnabled', 'allUrlsFollow']).catch(() => {});
  }
  return settings;
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

export function realtimeUrlFromBase(apiBase) {
  const url = new URL('/v1/realtime', apiBase || DEFAULT_API_BASE);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  return url.toString();
}

// 长期记忆的身份标识：
// - 共享记忆（默认）：所有角色用同一个 user，角色切换不会丢记忆
// - 独立记忆：每个角色各自一个 user
export function memoryUserId(settings, characterId) {
  const suffix = settings.separateMemory ? `-${characterId}` : '';
  return `hocho-${settings.installId}${suffix}`.slice(0, 128);
}

export function voiceCatalog(settings) {
  const map = new Map();
  for (const v of BUILTIN_VOICES) map.set(v.id, { id: v.id, name: v.name, builtin: true });
  for (const v of settings.accountVoices || []) {
    if (v?.id && !map.has(v.id)) map.set(v.id, { id: v.id, name: v.name });
  }
  for (const v of settings.customVoices || []) {
    if (v?.id) {
      const known = map.get(v.id);
      map.set(v.id, { id: v.id, name: known?.name || v.name || '自定义音色', custom: true });
    }
  }
  return [...map.values()];
}

// 音色下拉：两个内置音色 + 用户按 ID 自己添加的。
export function popularVoices(settings) {
  const map = new Map();
  for (const v of BUILTIN_VOICES) map.set(v.id, { id: v.id, name: v.name, builtin: true });
  for (const v of settings.customVoices || []) {
    if (!v?.id) continue;
    const known = (settings.accountVoices || []).find((a) => a.id === v.id);
    map.set(v.id, { id: v.id, name: known?.name || v.name || '自定义音色', custom: true });
  }
  return [...map.values()];
}

export function voiceLabel(settings, id) {
  if (!id) return '默认音色';
  return voiceCatalog(settings).find((v) => v.id === id)?.name || `音色 ${id.slice(0, 8)}`;
}
