// 闪避触发链：她开口时 tabAudio.setDucked(true) 必须被调用，说完必须恢复。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmPlayer } from '../../src/live/player.js';

function fakeAudio() {
  const dest = { connect() {}, disconnect() {} };
  class FakeCtx {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = dest; }
    createGain() {
      return {
        gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} },
        connect(n) { return n; }, disconnect() {},
      };
    }
    createDynamicsCompressor() {
      return {
        threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 1 },
        attack: { value: 0 }, release: { value: 0 },
        connect(n) { return n; }, disconnect() {},
      };
    }
    createBuffer(c, length, rate) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; }
    createBufferSource() {
      const node = { start() {}, stop() {}, connect() {}, onended: null };
      // 模拟播放结束：手动触发 onended
      node.finish = () => node.onended?.();
      return node;
    }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  return FakeCtx;
}

function withFakeAudio(fn) {
  const original = globalThis.AudioContext;
  globalThis.AudioContext = fakeAudio();
  return fn().finally(() => { globalThis.AudioContext = original; });
}

test('她开始说话时下发 ducked=true，说完恢复 ducked=false', async () => {
  await withFakeAudio(async () => {
    const player = new PcmPlayer();
    await player.init();

    const events = [];
    player.addEventListener('active', (e) => events.push(e.detail.active));

    const pcm = new Int16Array(4800).buffer; // 0.1s @48k
    player.getRun('r1', 't1');
    player.enqueue({ run_id: 'r1', turn_id: 't1', chunk_id: '1' }, pcm);

    assert.deepEqual(events, [true], '一开口就要通知压低视频');
    assert.equal(player.active, true);

    player.markAudioDone('r1', 't1');
    // 模拟播放结束
    const src = [...player.runs.values()][0].chunks[0].src;
    src.finish();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(events, [true, false], '说完要恢复视频音量');
  });
});

test('多个片段连续播放期间保持压低状态，不会中途恢复', async () => {
  await withFakeAudio(async () => {
    const player = new PcmPlayer();
    await player.init();
    const events = [];
    player.addEventListener('active', (e) => events.push(e.detail.active));

    player.getRun('r2', 't2');
    player.enqueue({ run_id: 'r2', turn_id: 't2', chunk_id: '1' }, new Int16Array(4800).buffer);
    player.enqueue({ run_id: 'r2', turn_id: 't2', chunk_id: '2' }, new Int16Array(4800).buffer);
    assert.deepEqual(events, [true]);

    const run = player.runs.get('r2');
    run.chunks[0].src.finish();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(events, [true], '还有下一段在播，不能恢复');

    player.markAudioDone('r2', 't2');
    run.chunks[1].src.finish();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(events, [true, false]);
  });
});
