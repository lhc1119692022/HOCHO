// MOSS HTTP 接口（普通 fetch 可以直接带 Authorization 请求头）。

import { DEFAULT_API_BASE } from './defaults.js';

export class MossApiError extends Error {
  constructor(status, body) {
    super(describeStatus(status, body));
    this.status = status;
    this.body = body;
  }
}

function describeStatus(status, body) {
  if (status === 401) return 'API Key 无效或已失效';
  if (status === 403) return '这个 Key 没有权限';
  if (status === 429) return '请求过于频繁或额度不足';
  const snippet = typeof body === 'string' ? body.slice(0, 120) : '';
  return `HTTP ${status}${snippet ? `：${snippet}` : ''}`;
}

async function request(path, { apiKey, apiBase, params } = {}) {
  const url = new URL(path, apiBase || DEFAULT_API_BASE);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch (error) {
    throw new Error(`无法访问 ${url.host}：${error.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new MossApiError(res.status, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('接口返回的不是 JSON');
  }
}

// 拉取可用模型列表。
// 注意：MOSS 的 /v1/models 只列出普通推理模型，不含实时对话 / 实时视频模型，
// 所以这里返回的列表仅作参考，不能用来判断 moss-live 是否可用。
export async function listModels({ apiKey, apiBase }) {
  const json = await request('/v1/models', { apiKey, apiBase });
  const ids = Array.isArray(json?.data) ? json.data.map((m) => m?.id).filter(Boolean) : [];
  return ids.map((id) => ({ id, name: modelLabel(id) }));
}

function modelLabel(id) {
  const map = {
    'moss-live-1.0': 'MOSS-Live（实时语音对话）',
    'moss-vl-realtime-1.0': 'MOSS-VL-Realtime（实时画面理解）',
    'moss-vl-1.0': 'MOSS-VL（图片/视频理解）',
  };
  return map[id] || id;
}

export async function listAccountVoices({ apiKey, apiBase }) {
  const voices = [];
  let after;
  for (let page = 0; page < 5; page += 1) {
    const json = await request('/v1/audio/voices', {
      apiKey,
      apiBase,
      params: { limit: 150, after },
    });
    for (const v of json?.data || []) {
      if (v?.id) voices.push({ id: v.id, name: v.name || '' });
    }
    if (!json?.has_more || !json?.next_cursor) break;
    after = json.next_cursor;
  }
  return voices;
}
