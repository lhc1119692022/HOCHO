// 视频监听（MOSS Live 连接 #2）的纯逻辑层。
//
// 规格 §4.3：第二条连接只做「视频感知」，输出事实/台词/人物/剧情/梗/音乐变化和
// 按类型的滚动摘要，不对用户说话、不扮演评论者、不播放 TTS。
// 这里不放 WebSocket 实现，方便在 Node 里做单元测试；连接由 session.js 注入。

/** 六类视频类型，规格 §1.4 / §4.3。 */
export const VIDEO_TYPES = [
  {
    id: 'knowledge',
    label: '科普/知识',
    rollingMs: 45000,
    prompt: '重点提取概念、术语、论点、数据和结论；标注关键定义和例子；不确定的专业内容明确写「不确定」，不要编造。',
  },
  {
    id: 'short',
    label: '短视频/段子',
    rollingMs: 20000,
    prompt: '只抓梗、笑点、反转和关键台词，按段落更新；不复述整段内容，不做剧情推演。',
  },
  {
    id: 'series',
    label: '连续剧/电影',
    rollingMs: 60000,
    prompt: '维护人物关系、剧情节点、伏笔和时间线；标注人物名和关系变化；保留跨段落的滚动剧情摘要。',
  },
  {
    id: 'music',
    label: '音乐/MV',
    rollingMs: 30000,
    prompt: '识别歌曲、歌手、歌词情绪和画面氛围；识别歌曲/歌手时标注置信度，不确定不要编造。',
  },
  {
    id: 'live',
    label: '直播/体育',
    rollingMs: 30000,
    prompt: '记录事件、比分、解说要点和时间节点；快节奏时只抓重点，不逐句复述解说。',
  },
  {
    id: 'general',
    label: '通用',
    rollingMs: 45000,
    prompt: '保守提取事实、对话和场景变化，不推测、不补充画面里没有的信息。',
  },
];

const TYPE_BY_ID = new Map(VIDEO_TYPES.map((type) => [type.id, type]));

export function videoType(id) {
  return TYPE_BY_ID.get(id) || TYPE_BY_ID.get('general');
}

export function isValidVideoType(id) {
  return TYPE_BY_ID.has(id);
}

/**
 * 自动判断视频类型（规格 §4.4）。
 * 只做保守的关键词/域名判断，结果始终允许用户手动覆盖。
 */
export function guessVideoType({ url = '', title = '', durationSec = 0 } = {}) {
  const text = `${title} ${url}`.toLowerCase();
  const has = (...words) => words.some((word) => text.includes(word));

  if (has('bilibili.com/video/', 'youtube.com/watch', 'youtu.be/')) {
    if (has('科普', '讲解', '教程', '纪录片', 'lecture', 'documentary', 'explained', '知识')) return 'knowledge';
    if (has('第', '集', 'ep', '番剧', '剧场版', '连续剧', 'episode', 'season')) return 'series';
    if (has('mv', '歌词', '音乐', 'official video', 'live performance')) return 'music';
    if (has('直播', '比赛', '赛后', '比分', 'highlight', 'match')) return 'live';
    if (Number(durationSec) > 0 && Number(durationSec) < 180) return 'short';
  }
  if (has('直播', '赛事', '比分')) return 'live';
  if (has('mv', '歌词', '单曲')) return 'music';
  if (has('科普', '纪录片', '讲座', '课程')) return 'knowledge';
  if (has('第', '集', 'ep', '剧场版')) return 'series';
  if (Number(durationSec) > 0 && Number(durationSec) < 180) return 'short';
  return 'general';
}

/**
 * 同一个视频的稳定标识：用于按视频保存摘要和手动选的类型。
 * 去掉 #锚点和常见的追踪参数；YouTube 只保留 v，B 站只保留分 P 的 p。
 */
export function videoKeyFromUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (!/^https?:$/.test(url.protocol)) return '';
  const keep = new URLSearchParams();
  const host = url.hostname.replace(/^www\./, '');
  if (/(^|\.)youtube\.com$/.test(host) && url.searchParams.get('v')) keep.set('v', url.searchParams.get('v'));
  if (/(^|\.)bilibili\.com$/.test(host) && url.searchParams.get('p')) keep.set('p', url.searchParams.get('p'));
  const query = keep.toString();
  return `${host}${url.pathname.replace(/\/$/, '')}${query ? `?${query}` : ''}`.slice(0, 300);
}

/** 主动评论三档的最短间隔（毫秒）。 */
export const PROACTIVE_INTERVAL_MS = { quiet: 60000, normal: 25000, lively: 12000 };

/** 发给主连接的主动评论请求（session.commentary.append 的内容）。 */
export function proactivePrompt(videoContext) {
  return `（陪看提示，不要念出这段话）视频里刚刚发生：${String(videoContext || '').slice(0, 600)}。如果值得说，就用你自己的语气自然地接一句，一到两句，不要提问，不要复述原话。`;
}

/** 视频监听连接的系统提示词（规格 §4.3）。 */
export function buildListenerPrompt({ typeId, personaPrompt = '', videoKey = '' } = {}) {
  const type = videoType(typeId);
  const base = [
    '你是当前视频的感知层，只负责输出视频里正在发生的事实、台词、人物、剧情节点、梗、音乐/音效变化和摘要。',
    '不要对用户说话，不要扮演评论者，不要输出建议或提问，不要说「我」。',
    '输出尽量短，按时间顺序；只描述视频里确实出现的内容，不确定就写「不确定」。',
  ];
  const parts = [...base, `当前视频类型：${type.label}。${type.prompt}`];
  if (personaPrompt) {
    parts.push(`你的观察视角带有以下角色气质（只影响措辞，不改变事实，不向用户表达）：${personaPrompt.slice(0, 600)}`);
  }
  if (videoKey) parts.push(`当前视频标识：${videoKey.slice(0, 200)}`);
  return parts.join('\n');
}

/** 生成注入主会话的上下文文本（规格 §4.3，单条不超过 2000 字符）。 */
export function formatContextLine({ atSec = 0, typeId, facts = '', quotes = '', people = '', summary = '' } = {}) {
  const type = videoType(typeId);
  const stamp = Number.isFinite(atSec) && atSec >= 0 ? ` @${formatOffset(atSec)}` : '';
  const fields = [
    facts && `事实：${facts}`,
    quotes && `关键台词：「${quotes}」`,
    people && `人物/剧情：${people}`,
    summary && `摘要：${summary}`,
  ].filter(Boolean);
  return `[视频监听${stamp} | 类型: ${type.label}]\n${fields.join('\n')}`.slice(0, 2000);
}

export function formatOffset(seconds) {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const rest = (total % 60).toFixed(1).padStart(4, '0');
  return `${String(minutes).padStart(2, '0')}:${rest}`;
}

/**
 * 视频监听连接的生命周期（规格 §1.3）。
 * - 连续约 300ms 检测到声音 → 建议建立连接
 * - 连续 30 秒静音 → 建议断开连接
 * - 断开后开关仍处于「待命」，下次有声会重新给出建立建议
 */
export class VideoListenerGate {
  constructor({ soundOnMs = 300, silenceOffMs = 30000 } = {}) {
    this.soundOnMs = soundOnMs;
    this.silenceOffMs = silenceOffMs;
    this.reset();
  }

  reset() {
    this.connected = false;
    this.soundStartedAt = 0;
    this.lastAudibleAt = 0;
  }

  /** @param audible 当前这一采样窗口是否检测到视频声音 @param nowMs performance.now() 毫秒 */
  sample(audible, nowMs) {
    if (audible) {
      this.lastAudibleAt = nowMs;
      if (!this.soundStartedAt) this.soundStartedAt = nowMs;
      if (!this.connected && nowMs - this.soundStartedAt >= this.soundOnMs) {
        this.connected = true;
        return 'start';
      }
      return null;
    }

    this.soundStartedAt = 0;
    if (!this.connected) return null;
    if (this.lastAudibleAt && nowMs - this.lastAudibleAt >= this.silenceOffMs) {
      this.connected = false;
      this.lastAudibleAt = 0;
      return 'stop';
    }
    return null;
  }

  /** 连接被外部关闭（例如 30 秒静音或切换视频）时，回到待命状态。 */
  detach() {
    this.connected = false;
    this.soundStartedAt = 0;
    this.lastAudibleAt = 0;
  }
}

/**
 * 按视频标识保存滚动摘要与关键台词（规格 §1.4 / §6.3）。
 * 纯数据结构，持久化由 session.js 通过 chrome.storage.local 完成。
 */
export class VideoSummary {
  constructor({ videoKey = '', typeId = 'general', maxQuotes = 12 } = {}) {
    this.videoKey = videoKey;
    this.typeId = isValidVideoType(typeId) ? typeId : 'general';
    this.maxQuotes = maxQuotes;
    this.facts = [];
    this.quotes = [];
    this.people = [];
    this.summary = '';
    this.lastRollingAt = 0;
  }

  append({ facts = '', quotes = '', people = '', summary = '', atMs = 0 } = {}) {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    if (clean(facts)) this.facts.push(clean(facts));
    if (clean(quotes)) this.quotes.push(clean(quotes));
    if (clean(people)) this.people.push(clean(people));
    if (clean(summary)) this.summary = clean(summary);
    this.facts = this.facts.slice(-20);
    this.quotes = this.quotes.slice(-this.maxQuotes);
    this.people = this.people.slice(-20);
    if (atMs) this.lastRollingAt = atMs;
  }

  /** 是否到了该产出滚动摘要的时间。 */
  shouldRoll(nowMs) {
    const interval = videoType(this.typeId).rollingMs;
    return nowMs - this.lastRollingAt >= interval;
  }

  markRolled(nowMs) {
    this.lastRollingAt = nowMs;
  }

  /** 重连时补回上下文（规格 §1.3）：滚动摘要、人物、关键台词和最近事实。 */
  replayText() {
    const parts = [];
    if (this.summary) parts.push(`此前摘要：${this.summary}`);
    if (this.people.length) parts.push(`人物/剧情：${this.people.slice(-4).join('；')}`);
    if (this.quotes.length) parts.push(`最近关键台词：${this.quotes.slice(-4).map((q) => `「${q}」`).join('；')}`);
    if (this.facts.length) parts.push(`最近事实：${this.facts.slice(-4).join('；')}`);
    return parts.join('\n');
  }

  snapshot() {
    return {
      videoKey: this.videoKey,
      typeId: this.typeId,
      facts: this.facts,
      quotes: this.quotes,
      people: this.people,
      summary: this.summary,
      lastRollingAt: this.lastRollingAt,
    };
  }

  static restore(data) {
    if (!data || typeof data !== 'object') return null;
    const store = new VideoSummary({ videoKey: data.videoKey || '', typeId: data.typeId });
    store.facts = Array.isArray(data.facts) ? data.facts.slice(-20) : [];
    store.quotes = Array.isArray(data.quotes) ? data.quotes.slice(-12) : [];
    store.people = Array.isArray(data.people) ? data.people.slice(-20) : [];
    store.summary = typeof data.summary === 'string' ? data.summary : '';
    store.lastRollingAt = Number(data.lastRollingAt) || 0;
    return store;
  }
}
