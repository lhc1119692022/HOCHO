// 后台 service worker：创建 offscreen 文档（会话真正运行的地方）、截取当前标签页画面、
// 注入鉴权请求头、代理设置读写。
//
// 为什么需要这里中转：offscreen 文档只暴露 chrome.runtime，
// 没有 storage / declarativeNetRequest / tabs，所以这些能力必须由后台代劳。

import { installAuthRule, removeAuthRule } from './shared/auth-rule.js';
import { loadSettings, saveSettings } from './shared/storage.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
let creating = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: '运行实时语音陪伴会话：麦克风采集、语音播放与画面上传。',
  });
  try {
    await creating;
  } finally {
    creating = null;
  }
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

// 给 offscreen 用的标签页声音采集入口。真正的 getUserMedia 在 offscreen 里做，
// 这里只负责拿 streamId（offscreen 没有 tabCapture）。
async function tabAudioStream(tabId = null) {
  if (!chrome.tabCapture?.getMediaStreamId) {
    throw new Error('当前浏览器不支持采集标签页声音');
  }
  let tab = null;
  if (Number.isInteger(tabId)) tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    const tabs = win ? await chrome.tabs.query({ active: true, windowId: win.id }).catch(() => []) : [];
    tab = tabs[0] || null;
  }
  if (!tab?.id) throw new Error('没有找到正在看的标签页');
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  return { streamId, tabId: tab.id, title: tab.title || '', url: tab.url || '' };
}

// 截取用户此刻正在看的标签页。
// 关键：只有“当前可见的标签页”就是陪看目标时才有意义——否则画面和声音会对不上。
// 所以这里对比 targetTabId，不一致就返回 otherTab，由会话跳过这一帧并在界面上说清楚。
// chrome:// 之类的页面无法截取，返回 skip。
async function captureVisible(targetTabId = null) {
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (!win || win.state === 'minimized') return { ok: false, skip: true };
  if (Number.isInteger(targetTabId)) {
    const [active] = await chrome.tabs.query({ active: true, windowId: win.id }).catch(() => []);
    if (active && active.id !== targetTabId) {
      return { ok: false, otherTab: true, title: active.title || '', tabId: active.id };
    }
  }
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(win.id, { format: 'jpeg', quality: 80 });
    return dataUrl ? { ok: true, dataUrl } : { ok: false, skip: true };
  } catch (error) {
    return { ok: false, skip: true, error: String(error?.message || error) };
  }
}

// ---------- 图标角标：一眼看出“这个网页有没有在生效” ----------
//
// 每个标签页单独显示，所以在任何网页上抬头看图标就知道状态：
//   ●  绿：这个网页正在陪看（声音和画面都是它）
//   ●  黄：正在陪看，但看的是别的网页 —— 当前页没生效
//   ！  红：出错了
//   空    ：没在陪看
const BADGE_COLORS = { live: '#18B67A', other: '#E5A23B', error: '#E5484D' };
let sessionStatus = { state: 'idle', targetTabId: null };

async function paintBadge(tabId) {
  let text = '';
  let color = BADGE_COLORS.live;
  if (sessionStatus.state === 'error') {
    text = '!';
    color = BADGE_COLORS.error;
  } else if (['live', 'connecting', 'reconnecting'].includes(sessionStatus.state)) {
    const isTarget = Number.isInteger(sessionStatus.targetTabId) && tabId === sessionStatus.targetTabId;
    // 连接中先在目标页显示黄点，连上后变绿。
    text = '●';
    color = isTarget && sessionStatus.state === 'live' ? BADGE_COLORS.live : BADGE_COLORS.other;
  }
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeTextColor?.({ tabId, color: '#FFFFFF' });
  } catch {
    // 标签页已关闭时忽略。
  }
}

async function repaintAllBadges() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const tab of tabs) {
    if (tab.id) await paintBadge(tab.id);
  }
}

// 切换标签页时立刻更新角标：这样在任何页面上抬头看图标就知道这个页面有没有在生效。
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await paintBadge(tabId);
  const { allUrlsFollow } = await chrome.storage.local.get('allUrlsFollow');
  if (!allUrlsFollow) return;
  const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
  if (!granted) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || /^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url || '')) return;
  chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'tab-activated',
    payload: { tabId, url: tab.url || '', title: tab.title || '' },
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(() => {
  chrome.action.setBadgeText({ text: '' }).catch(() => {});
});

// 新开 / 切换到的标签页也要立刻有角标，否则用户看不出这个网页有没有在生效。
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id) setTimeout(() => paintBadge(tab.id), 300);
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete') paintBadge(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 会话把状态报给后台，后台据此画角标（offscreen 没有 action API）。
  if (msg?.target === 'bg' && msg.type === 'session-status') {
    sessionStatus = {
      state: msg.payload?.state || 'idle',
      targetTabId: Number.isInteger(msg.payload?.targetTabId) ? msg.payload.targetTabId : sessionStatus.targetTabId,
    };
    repaintAllBadges();
    sendResponse({ ok: true });
    return false;
  }
  if (!msg || msg.target !== 'bg') return undefined;

  (async () => {
    try {
      switch (msg.type) {
        case 'ensure-offscreen':
          await ensureOffscreen();
          sendResponse({ ok: true });
          break;
        case 'close-offscreen':
          await closeOffscreen();
          sendResponse({ ok: true });
          break;
        case 'capture-visible':
          sendResponse(await captureVisible(msg.payload?.targetTabId));
          break;
        case 'tab-audio-stream':
          sendResponse({ ok: true, ...(await tabAudioStream(msg.payload?.tabId)) });
          break;
        // offscreen 没有 storage / declarativeNetRequest，统一由后台代做。
        case 'auth-rule-install':
          await installAuthRule(msg.payload);
          sendResponse({ ok: true });
          break;
        case 'auth-rule-remove':
          await removeAuthRule();
          sendResponse({ ok: true });
          break;
        case 'load-settings':
          sendResponse({ ok: true, settings: await loadSettings() });
          break;
        case 'save-settings':
          await saveSettings(msg.payload || {});
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
