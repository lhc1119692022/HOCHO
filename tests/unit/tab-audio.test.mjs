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
  };
  return { gain: param, calls };
}

test('她说话时把视频音量压到 16%，说完平滑恢复到 100%', () => {
  const capture = new TabAudioCapture();
  const fake = fakeGain();
  capture.ctx = { currentTime: 1 };
  capture.gain = fake;

  capture.setDucked(true);
  assert.equal(capture.ducked, true);
  assert.deepEqual(fake.calls.at(-1), ['ramp', 0.16, 1.12]);

  capture.setDucked(false);
  assert.equal(capture.ducked, false);
  assert.deepEqual(fake.calls.at(-1), ['ramp', 1, 1.28]);
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
