// 视频监听层纯逻辑测试（规格 §1.3 / §1.4 / §4.3 / §4.4）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIDEO_TYPES,
  isValidVideoType,
  videoType,
  guessVideoType,
  buildListenerPrompt,
  formatContextLine,
  formatOffset,
  VideoListenerGate,
  VideoSummary,
} from '../../src/live/video-listener.js';

test('六类视频类型齐全且各有不同的摘要间隔与提示词', () => {
  assert.equal(VIDEO_TYPES.length, 6);
  const ids = VIDEO_TYPES.map((t) => t.id);
  assert.deepEqual(ids, ['knowledge', 'short', 'series', 'music', 'live', 'general']);
  assert.equal(new Set(VIDEO_TYPES.map((t) => t.prompt)).size, 6);
  assert.ok(VIDEO_TYPES.every((t) => t.rollingMs > 0 && t.label));
  assert.equal(isValidVideoType('series'), true);
  assert.equal(isValidVideoType('nope'), false);
  assert.equal(videoType('nope').id, 'general');
});

test('自动判断视频类型：科普 / 连续剧 / 音乐 / 短视频 / 通用', () => {
  assert.equal(guessVideoType({ url: 'https://www.bilibili.com/video/BV1xx', title: '量子力学 科普 讲解' }), 'knowledge');
  assert.equal(guessVideoType({ url: 'https://www.bilibili.com/video/BV2xx', title: '某某剧 第 12 集' }), 'series');
  assert.equal(guessVideoType({ url: 'https://www.youtube.com/watch?v=abc', title: '官方 MV' }), 'music');
  assert.equal(guessVideoType({ url: 'https://www.bilibili.com/video/BV3xx', title: '随手拍', durationSec: 45 }), 'short');
  assert.equal(guessVideoType({ url: 'https://example.com/page', title: '一个普通页面' }), 'general');
});

test('监听提示词限定为感知层，且随类型变化', () => {
  const knowledge = buildListenerPrompt({ typeId: 'knowledge', personaPrompt: '说话温柔', videoKey: 'video-1' });
  const series = buildListenerPrompt({ typeId: 'series', personaPrompt: '说话温柔', videoKey: 'video-1' });
  assert.match(knowledge, /不要对用户说话/);
  assert.match(knowledge, /不要扮演评论者/);
  assert.match(knowledge, /说话温柔/);
  assert.match(knowledge, /概念、术语、论点/);
  assert.match(series, /人物关系、剧情节点/);
  assert.notEqual(knowledge, series);
  assert.ok(!knowledge.includes('请主动评论'));
});

test('上下文注入格式带时间戳和类型，且不超过 2000 字符', () => {
  const line = formatContextLine({
    atSec: 72.4,
    typeId: 'series',
    facts: '主角在雨中接到电话',
    quotes: '你终于肯接了',
    people: '主角与旧友关系出现裂痕',
    summary: '伏笔出现',
  });
  assert.match(line, /\[视频监听 @01:12\.4 \| 类型: 连续剧\/电影\]/);
  assert.match(line, /关键台词：「你终于肯接了」/);
  const long = formatContextLine({ atSec: 1, typeId: 'general', facts: '啊'.repeat(5000) });
  assert.ok(long.length <= 2000);
  assert.equal(formatOffset(0), '00:00.0');
  assert.equal(formatOffset(61.25), '01:01.3');
});

test('监听连接按 300ms 声音建立、30 秒静音断开，断开后仍能重建', () => {
  const gate = new VideoListenerGate({ soundOnMs: 300, silenceOffMs: 30000 });
  let now = 1000;
  assert.equal(gate.sample(true, now), null, '刚开始有声还不建连');
  now += 299;
  assert.equal(gate.sample(true, now), null);
  now += 1;
  assert.equal(gate.sample(true, now), 'start');
  assert.equal(gate.connected, true);
  now += 100;
  assert.equal(gate.sample(true, now), null, '已连接后不重复建连');

  // 静音计时从「最后一次有声」起算，不是从第一次静音采样起算。
  now += 1000;
  assert.equal(gate.sample(false, now), null, '刚静音不立即断开');
  now += 28999;
  assert.equal(gate.sample(false, now), null, '差 1ms 到 30 秒仍不断开');
  now += 1;
  assert.equal(gate.sample(false, now), 'stop');
  assert.equal(gate.connected, false);

  now += 100;
  assert.equal(gate.sample(true, now), null, '断开后重新累计 300ms');
  now += 300;
  assert.equal(gate.sample(true, now), 'start', '再次有声可重建');
});

test('切换视频时 gate 重置，摘要不会带进新视频', () => {
  const gate = new VideoListenerGate({ soundOnMs: 300, silenceOffMs: 30000 });
  gate.sample(true, 1000);
  gate.sample(true, 1300);
  assert.equal(gate.connected, true);
  gate.reset();
  assert.equal(gate.connected, false);
  assert.equal(gate.sample(true, 2000), null);
  assert.equal(gate.sample(true, 2300), 'start');
});

test('滚动摘要按类型间隔触发，重连时能补回上下文', () => {
  const summary = new VideoSummary({ videoKey: 'video-1', typeId: 'series' });
  assert.equal(summary.shouldRoll(0), false, '还没有内容时不产出滚动摘要');
  assert.equal(summary.shouldRoll(60000), true, '积累满一个间隔才产出');
  summary.markRolled(1000);
  assert.equal(summary.shouldRoll(1000 + 30000), false, '连续剧间隔 60 秒');
  assert.equal(summary.shouldRoll(1000 + 60000), true);

  summary.append({ facts: '雨中接电话', quotes: '你终于肯接了', people: '主角与旧友', summary: '伏笔出现', atMs: 1000 });
  const replay = summary.replayText();
  assert.match(replay, /此前摘要：伏笔出现/);
  assert.match(replay, /「你终于肯接了」/);

  const restored = VideoSummary.restore(summary.snapshot());
  assert.equal(restored.videoKey, 'video-1');
  assert.equal(restored.typeId, 'series');
  assert.match(restored.replayText(), /伏笔出现/);
  assert.equal(VideoSummary.restore(null), null);
});

test('摘要有界，不会无限增长', () => {
  const summary = new VideoSummary({ videoKey: 'v', maxQuotes: 3 });
  for (let i = 0; i < 20; i += 1) {
    summary.append({ facts: `事实${i}`, quotes: `台词${i}`, people: `人物${i}` });
  }
  assert.equal(summary.quotes.length, 3);
  assert.equal(summary.facts.length, 20);
  assert.match(summary.quotes.at(-1), /台词19/);
});
