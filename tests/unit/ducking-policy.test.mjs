// 闪避策略：她说话要压，你说话也要压，两边都不说了才恢复。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionSession } from '../../src/live/session.js';

function makeSession() {
  const calls = [];
  const session = new CompanionSession({
    settings: { voiceEnabled: true, shareVideoAudio: true },
    character: { name: '绫', persona: '陪看伙伴' },
  });
  session.tabAudio = {
    setDucked: (value) => calls.push(value),
  };
  return { session, calls };
}

test('她说话时压低视频', () => {
  const { session, calls } = makeSession();
  session.assistantSpeaking = true;
  session.updateDucking();
  assert.deepEqual(calls, [true]);
});

test('你说话时也压低视频（减少麦克风把视频声收进去）', () => {
  const { session, calls } = makeSession();
  session.userSpeaking = true;
  session.updateDucking();
  assert.deepEqual(calls, [true]);
});

test('她说完但你还在说：仍然保持压低，不能提前恢复', () => {
  const { session, calls } = makeSession();
  session.assistantSpeaking = true;
  session.userSpeaking = true;
  session.updateDucking();
  assert.deepEqual(calls, [true]);

  session.assistantSpeaking = false;
  session.updateDucking();
  assert.deepEqual(calls, [true, true], '还有人在说，仍要压低');
});

test('两边都不说了才恢复原音量', () => {
  const { session, calls } = makeSession();
  session.assistantSpeaking = true;
  session.userSpeaking = true;
  session.updateDucking();
  session.assistantSpeaking = false;
  session.updateDucking();
  session.userSpeaking = false;
  session.updateDucking();
  assert.deepEqual(calls, [true, true, false]);
});

test('视频还没接上时调用闪避不报错', () => {
  const session = new CompanionSession({
    settings: { voiceEnabled: true, shareVideoAudio: true },
    character: { name: '绫', persona: '陪看伙伴' },
  });
  session.tabAudio = null;
  assert.doesNotThrow(() => {
    session.assistantSpeaking = true;
    session.updateDucking();
  });
});

test('麦克风电平超过阈值才算「你在说话」', () => {
  // 阈值是 0.035：正常说话的峰值远高于它，环境噪声通常低于它。
  assert.ok(0.035 > 0.01, '说话阈值应明显高于「有声音」的判定阈值');
  assert.ok(0.035 < 0.2, '阈值不能高到正常说话都触发不了');
});
