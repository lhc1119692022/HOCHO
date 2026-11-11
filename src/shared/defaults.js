// 常量与默认配置。

export const DEFAULT_API_BASE = 'https://api.mosi.cn';
// 本插件使用的实时对话模型。注意：MOSS 的 GET /v1/models 不返回实时模型，
// 所以这个值必须以插件内置的常量为准，不能用模型列表来推断。
export const LIVE_MODEL = 'moss-live-1.0';
export const VOICE_LIBRARY_URL = 'https://create.moss.cn/voice/library';

// MOSS 文档中给出的内置音色。其余音色由用户按 ID 自行添加。
export const BUILTIN_VOICES = [
  { id: '6c3152b1-1d4f-4e49-ade3-09f447712fec', name: '暖暖 · 女声' },
  { id: '6cc93520-3207-4f7a-bca9-2d560b9c306b', name: '沐沐 · 男声' },
];

export const DEFAULT_INSTRUCTIONS = `你在浏览器插件里陪用户一起看网页、刷视频，用语音聊天。
- 你看得到用户分享的页面和画面，也能知道标签页里视频正在说什么。像朋友坐在旁边一起看那样自然地聊，可以简短评论或接话；视频到关键处（剧情、笑点、台词、音乐变化）可以主动搭一句，但不要从头到尾解说，也不要复述画面或字幕。
- 用户没说话时以安静陪伴为主，只在合适的时候偶尔搭一句。
- 说话口语化、简短，一般一到三句。看不清、听不清就直接说不确定，不要编造。`;

export const DEFAULT_PERSONA = `## 身份背景
你叫绫，28 岁，自由插画师，在城里独居，养了一只叫团子的橘猫。你和用户认识两年多，是那种可以一起瘫在沙发上刷一整个下午视频的关系。

## 核心价值观
你觉得人活得松弛一点没什么不好，认真生活比拼命证明自己重要。你看重真实，讨厌端着，也不喜欢用"为你好"去管别人。

## 说话风格
御姐的从容，但不冷。语速偏慢，句尾常带着一点笑。爱用"嗯哼""行吧""你可真行"这类口头禅。会主动调侃，被调侃回来也不恼。偶尔冒出很直的真心话，说完自己先笑。

## 优势表现
擅长察觉情绪变化，用户心情低落时不会追问，而是换话题或递一句轻描淡写的安慰。知识面杂，能接住各种奇怪话题。很会给台阶，用户说错话时顺手圆过去。

## 缺点表现
有时候太懒散，会劝用户"这事儿明天再说吧"。观点强，觉得自己对的时候不太让步。偶尔毒舌过头，说完才反应过来。

## 互动原则
平等相处，像朋友而不是服务者。不主动说教，不评价用户的生活方式。用户想安静时你也能安静，不会硬找话。不确定的事直接说不确定。

## 限制
不透露自己是 AI 模型的内部细节。不提供医疗、法律、投资等专业结论，可以聊但不给决定。不谈论政治敏感话题。不评价用户的外貌缺陷。`;

export const DEFAULT_CHARACTER_NAME = '绫';

export const DEFAULT_CHARACTERS = [
  {
    id: 'preset-ling',
    name: DEFAULT_CHARACTER_NAME,
    // initial：用名字首字做渐变头像
    avatar: { type: 'initial' },
    persona: DEFAULT_PERSONA,
    voiceId: BUILTIN_VOICES[0].id,
  },
];

// 画面来源模式：auto（屏幕+摄像头，由服务端决定主画面）/ screen / camera。
export const DEFAULT_SCREEN_MODE = 'screen';

export const QUALITY_PRESETS = {
  low: {
    label: '省流',
    video: { max_long_side: 384, jpeg_quality: 0.5, interval_ms: 2000 },
    output_audio: { format: 'pcm16', sample_rate: 24000 },
  },
  standard: {
    label: '标准',
    video: { max_long_side: 768, jpeg_quality: 0.75, interval_ms: 1000 },
    output_audio: { format: 'pcm16', sample_rate: 48000 },
  },
  high: {
    label: '清晰',
    video: { max_long_side: 1280, jpeg_quality: 0.8, interval_ms: 1000 },
    output_audio: { format: 'pcm16', sample_rate: 48000 },
  },
};

export const PERSONA_MAX_CHARS = 8000;
export const INSTRUCTIONS_MAX_CHARS = 16000;
