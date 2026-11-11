// 标签页声音的本地逻辑测试：不启动浏览器，只验证压低/恢复的增益曲线和“有声音”判定。
import test from 'node:test';
import assert from 'node:assert/strict';
import { TabAudioCapture } from '../../src/live/tab-audio.js';

function fakeGain() {
  const calls = [];
  const param = {
    value: 1,
    cancelScheduledValues: (t) => calls.push(['cancel', t]),
    setValueAtTime: (v, t) => calls.push(['set', v, t]),
    linearRampToValueAtTime: (v, t) => calls.push(['ramp', v, t]),
    setTargetAtTime: (v, t, c) => calls.push(['target', v, t, c]),
  };
  return { gain: param, calls };
}

// 增益是浮点乘法，比较时用近似值，避免 0.6000000000000001 这种误差误报。
function assertLast(calls, kind, value, time) {
  const last = calls.at(-1);
  assert.equal(last[0], kind, `期望 ${kind}，实际 ${last[0]}`);
  assert.ok(Math.abs(last[1] - value) < 1e-9, `增益 ${last[1]} 应约等于 ${value}`);
  assert.ok(Math.abs(last[2] - time) < 1e-9, `时间 ${last[2]} 应约等于 ${time}`);
}

test('她说话时把视频压到 40%，说完恢复到 100%（不要压到听不见）', () => {
  const capture = new TabAudioCapture();
  const fake = fakeGain();
  capture.ctx = { currentTime: 1 };
  capture.gain = fake;

  capture.setDucked(true);
  assert.equal(capture.ducked, true);
  assertLast(fake.calls, 'ramp', 0.4, 1.12);

  capture.setDucked(false);
  assert.equal(capture.ducked, false);
  assertLast(fake.calls, 'ramp', 1, 1.28);
});

test('用户把视频音量调到 150%：压低时按比例算，恢复也回到 150%', () => {
  const capture = new TabAudioCapture({ volume: 1.5 });
  const fake = fakeGain();
  capture.ctx = { currentTime: 1 };
  capture.gain = fake;
  assert.equal(capture.targetGain(), 1.5);

  capture.setDucked(true);
  assertLast(fake.calls, 'ramp', 0.6, 1.12); // 1.5 × 0.4

  capture.setDucked(false);
  assertLast(fake.calls, 'ramp', 1.5, 1.28);
});

test('音量调小到 50% 后，正在压低状态也按新值重算', () => {
  const capture = new TabAudioCapture({ volume: 1 });
  const fake = fakeGain();
  capture.ctx = { currentTime: 2 };
  capture.gain = fake;

  capture.setDucked(true);
  capture.setVolume(0.5);
  assert.equal(capture.volume, 0.5);
  assertLast(fake.calls, 'target', 0.2, 2); // 0.5 × 0.4

  capture.setDucked(false);
  assertLast(fake.calls, 'ramp', 0.5, 2.28);
});

test('非法音量被忽略，不会把声音弄没', () => {
  const capture = new TabAudioCapture({ volume: 1 });
  capture.setVolume(-1);
  capture.setVolume('abc');
  capture.setVolume(NaN);
  assert.equal(capture.volume, 1);
});

test('只有达到阈值才判定为“正在听视频”', () => {
  const capture = new TabAudioCapture();
  const samples = new Float32Array(8);
  capture.analyser = {
    fftSize: 8,
    getFloatTimeDomainData(target) {
      target.set(samples);
    },
  };
  capture.levelData = new Float32Array(8);

  samples.fill(0.0001);
  capture.sample();
  assert.equal(capture.audible, false);

  samples.fill(0.02);
  capture.sample();
  assert.equal(capture.audible, true);
});
