// offscreen 文档能用的浏览器 API 很有限：只有 chrome.runtime，
// 没有 storage / declarativeNetRequest / tabs。所以这里全部通过 background 代理。

export async function bg(type, payload) {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ target: 'bg', type, payload });
  } catch (error) {
    throw new Error(`后台不可用：${error?.message || error}`);
  }
  if (!res) throw new Error('后台没有响应');
  if (!res.ok) throw new Error(res.error || '后台处理失败');
  return res;
}

export const authRule = {
  install: (apiKey, realtimeUrl) => bg('auth-rule-install', { apiKey, realtimeUrl }),
  remove: () => bg('auth-rule-remove').catch(() => {}),
};

export async function loadSettingsFromBg() {
  const res = await bg('load-settings');
  return res.settings;
}

export function saveSettingsToBg(patch) {
  return bg('save-settings', patch);
}

// 截不到时返回 null（例如用户正在看 chrome:// 页面），不抛错。
// targetTabId 用来判断“当前可见页”是不是陪看目标；不是就不截，避免画面和声音对不上。
export async function captureVisible(targetTabId = null) {
  try {
    const res = await chrome.runtime.sendMessage({
      target: 'bg',
      type: 'capture-visible',
      payload: { targetTabId },
    });
    if (res?.otherTab) {
      const error = new Error('当前显示的不是陪看中的网页');
      error.otherTab = true;
      error.title = res.title;
      throw error;
    }
    return res?.ok ? res.dataUrl : null;
  } catch (error) {
    if (error?.otherTab) throw error;
    return null;
  }
}

// 让后台画图标角标：哪个网页在陪看、哪个没生效、有没有出错。
export function reportSessionStatus(payload) {
  return chrome.runtime.sendMessage({ target: 'bg', type: 'session-status', payload }).catch(() => {});
}
