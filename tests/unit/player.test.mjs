// 她的声音播放：默认音量提升 + 限幅器，保证比视频原声响、调大也不破音。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmPlayer } from '../../src/live/player.js';

// 一个最小可用的假 Web Audio 环境，只记录连接关系和增益值。
function fakeAudio() {
  const created = { gain: [], compressor: [], bufferSource: [] };
  const dest = { connect() {}, disconnect() {} };
  class FakeCtx {
    constructor() {
      this.currentTime = 0;
      this.state = 'running';
      this.destination = dest;
    }
    createGain() {
      const node = {
        gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} },
        connectedTo: null,
        connect(next) { this.connectedTo = next; return next; },
        disconnect() {},
      };
      created.gain.push(node);
      return node;
    }
    createDynamicsCompressor() {
      const node = {
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 1 },
        attack: { value: 0 },
        release: { value: 0 },
        connectedTo: null,
        connect(next) { this.connectedTo = next; return next; },
        disconnect() {},
      };
      created.compressor.push(node);
      return node;
    }
    createBuffer(channels, length, rate) {
      return {
        duration: length / rate,
        getChannelData: () => new Float32Array(length),
      };
    }
    createBufferSource() {
      const node = { start() {}, stop() {}, connect() {}, onended: null };
      created.bufferSource.push(node);
      return node;
    }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  return { FakeCtx, created, dest };
}

async function playerWithFakeCtx() {
  const fake = fakeAudio();
  const player = new PcmPlayer();
  const original = globalThis.AudioContext;
  globalThis.AudioContext = fake.FakeCtx;
  try {
    await player.init();
  } finally {
    globalThis.AudioContext = original;
  }
  return { player, fake };
}

test('她的声音默认就比原声大（1.8 倍），不是 1 倍', async () => {
  const { player, fake } = await playerWithFakeCtx();
  assert.equal(fake.created.gain[0].gain.value, 1.8);
  assert.equal(player.volume, 1.8);
});

test('音量提升后接限幅器，调大不会破音', async () => {
  const { fake } = await playerWithFakeCtx();
  const [gainNode] = fake.created.gain;
  const [limiter] = fake.created.compressor;
  assert.equal(gainNode.connectedTo, limiter, '增益后面必须接限幅器');
  assert.equal(limiter.connectedTo, fake.dest, '限幅器接到扬声器');
  assert.equal(limiter.threshold.value, -3);
  assert.equal(limiter.ratio.value, 20);
});

test('调到 300% 时增益跟着变，仍然经过限幅器', async () => {
  const { player, fake } = await playerWithFakeCtx();
  player.setVolume(3);
  assert.equal(fake.created.gain[0].gain.value, 3);
  assert.equal(fake.created.gain[0].connectedTo, fake.created.compressor[0]);
});

test('init 之前设置音量也会生效（不会丢）', async () => {
  const fake = fakeAudio();
  const player = new PcmPlayer();
  player.setVolume(2.5);
  const original = globalThis.AudioContext;
  globalThis.AudioContext = fake.FakeCtx;
  try {
    await player.init();
  } finally {
    globalThis.AudioContext = original;
  }
  assert.equal(fake.created.gain[0].gain.value, 2.5);
});

test('非法音量被忽略', async () => {
  const { player } = await playerWithFakeCtx();
  player.setVolume(-2);
  player.setVolume('x');
  assert.equal(player.volume, 1.8);
});
