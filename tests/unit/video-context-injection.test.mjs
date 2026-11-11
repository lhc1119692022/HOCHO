// 视频监听结果 → 主会话静默上下文注入链路（规格 §4.3 / §6.2）。
// CompanionSession 的纯逻辑部分可在 Node 里实例化，用假的 client 捕获发送的消息。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionSession } from '../../src/live/session.js';
import { formatContextLine } from '../../src/live/video-listener.js';

function makeSession() {
  const sent = [];
  const session = new CompanionSession({
    settings: { voiceEnabled: true, shareVideoAudio: true },
    character: { name: '绫', persona: '陪看伙伴' },
  });
  session.connectionReady = true;
  session.client = { send: (msg) => sent.push(msg) };
  session.timelineStartedAt = performance.now();
  session.videoTypeId = 'series';
  session.videoKey = 'tab-7';
  return { session, sent };
}

test('视频监听输出通过 session.thinking.append 注入主会话，不进入用户消息位置', () => {
  const { session, sent } = makeSession();
  const context = formatContextLine({
    atSec: 12.4,
    typeId: 'series',
    facts: '主角在雨中接到电话',
    quotes: '你终于肯接了',
    summary: '伏笔出现',
  });
  session.injectVideoContext(context);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'session.thinking.append');
  assert.match(sent[0].content, /\[视频监听 @00:12\.4 \| 类型: 连续剧\/电影\]/);
  assert.match(sent[0].content, /关键台词：「你终于肯接了」/);
  assert.ok(sent[0].event_id?.startsWith('video-'));
  assert.equal(session.messages.length, 0, '视频监听不能生成任何用户可见消息');
});

test('主会话未就绪时视频上下文先缓存，连上后补发且不丢失顺序', () => {
  const { session, sent } = makeSession();
  session.connectionReady = false;
  session.injectVideoContext('第一条上下文');
  session.injectVideoContext('第二条上下文');
  assert.equal(sent.length, 0);
  assert.equal(session.pendingVideoLines.length, 2);
  session.connectionReady = true;
  session.flushVideoTranscripts();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].content, '第一条上下文');
  assert.equal(sent[1].content, '第二条上下文');
  assert.equal(session.pendingVideoLines.length, 0);
});

test('onVideoListenerTranscript 只取 final，并写入按视频的滚动摘要', async () => {
  const { session, sent } = makeSession();
  const { VideoSummary } = await import('../../src/live/video-listener.js');
  session.videoSummary = new VideoSummary({ videoKey: 'tab-7', typeId: 'series' });

  session.onVideoListenerTranscript({ text: '主角在雨中', final: false });
  assert.equal(sent.length, 0, 'interim 不注入');
  session.onVideoListenerTranscript({ text: '主角在雨中接到电话，镜头切到旧照片。', final: true });
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /主角在雨中接到电话/);
  assert.match(session.videoSummary.replayText(), /主角在雨中接到电话/);
});

test('用户消息只在 2 秒麦克风活动窗口内生成', () => {
  const { session } = makeSession();
  session.voiceEnabled = true;
  session.lastMicVoiceAt = 0;
  session.onUserTranscript({ text: '这句话不该显示', turn: 't1' }, true);
  assert.equal(session.messages.length, 0, '没有近期麦克风活动时不生成用户消息');

  session.lastMicVoiceAt = Date.now();
  session.onUserTranscript({ text: '这个梗是什么意思？', turn: 't2' }, true);
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0].role, 'user');
  assert.equal(session.messages[0].text, '这个梗是什么意思？');
  assert.ok(session.messages[0].id.startsWith('user-u-'), '每次用户输入有独立消息 ID');
});

test('Agent 回复按 run_id 更新同一条，第二轮不覆盖第一轮', () => {
  const { session } = makeSession();
  session.onAssistantTranscript({ text: '第一段', run_id: 'r1', turn_id: 't1' }, true);
  session.onAssistantTranscript({ text: '第二段', run_id: 'r2', turn_id: 't2' }, true);
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[0].id, 'assistant-r1');
  assert.equal(session.messages[1].id, 'assistant-r2');
  assert.equal(session.messages[0].text, '第一段');
  assert.equal(session.messages[1].text, '第二段');
});

test('主动评论在真实协议验证通过前不向服务端发送播报请求（GATE）', () => {
  const { session, sent } = makeSession();
  session.proactivityVerified = false;
  session.maybeProactiveComment('关键转折');
  assert.equal(sent.length, 0);
});

test('说话优先级：用户说话或主 Agent 正在回答时不主动评论', () => {
  const { session, sent } = makeSession();
  session.proactivityVerified = true;
  session.character.proactivity = 'lively'; // 档位存在角色上
  session.lastProactiveAt = 0;

  session.lastMicVoiceAt = Date.now(); // 用户刚说话
  session.maybeProactiveComment('关键转折');
  assert.equal(sent.length, 0, '用户优先');

  session.lastMicVoiceAt = 0;
  session.player = { active: true }; // 主 Agent 正在回答
  session.maybeProactiveComment('关键转折');
  assert.equal(sent.length, 0, '主 Agent 优先');

  session.player = { active: false };
  session.maybeProactiveComment('关键转折');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'session.commentary.append');
  assert.match(sent[0].content, /关键转折/);

  session.maybeProactiveComment('又一个转折');
  assert.equal(sent.length, 1, '「活泼」也有最短间隔，不会连着说');
});

test('只记你真说过的话：麦克风没动静时，识别出的字不进字幕', () => {
  const { session } = makeSession();
  const lines = [];
  session.addEventListener('transcript', (e) => lines.push(e.detail));
  session.lastMicVoiceAt = 0;
  session.onUserTranscript({ text: '视频里的台词', turn: 'a' }, false);
  session.onUserTranscript({ text: '视频里的台词。', turn: 'a' }, true);
  assert.equal(lines.length, 0);

  session.lastMicVoiceAt = Date.now();
  session.onUserTranscript({ text: '这是我说的', turn: 'b' }, false);
  session.lastMicVoiceAt = 0; // 说完了，最终结果晚一点才到，仍然算你说的
  session.onUserTranscript({ text: '这是我说的。', turn: 'b' }, true);
  assert.deepEqual(lines.map((l) => l.text), ['这是我说的', '这是我说的。']);
});

test('视频按网址区分：同一视频的标识稳定，去掉无关参数', async () => {
  const { videoKeyFromUrl } = await import('../../src/live/video-listener.js');
  assert.equal(
    videoKeyFromUrl('https://www.youtube.com/watch?v=abc&t=30s#x'),
    'youtube.com/watch?v=abc',
  );
  assert.equal(
    videoKeyFromUrl('https://www.bilibili.com/video/BV1xx/?spm_id_from=333&p=2'),
    'bilibili.com/video/BV1xx?p=2',
  );
  assert.equal(videoKeyFromUrl('chrome://settings'), '');
});
