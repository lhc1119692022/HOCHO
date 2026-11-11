import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionSession } from '../../src/live/session.js';

test('切到其他标签时停止旧音轨但不自动更换目标', () => {
  const session = new CompanionSession({
    settings: { screenMode: 'screen', targetTabId: 17, voiceEnabled: true },
    character: { name: '绫', persona: '陪看伙伴' },
  });
  session.state = 'live';
  let stopped = false;
  const videos = [];
  const events = [];
  const statuses = [];
  session.tabAudio = { stop: () => { stopped = true; } };
  session.sources.screen = { setVideo: (video) => videos.push(video) };
  session.clearVideoContext = () => {};
  session.stopVideoSampling = () => {};
  session.tabAudioState = () => ({ active: false });
  session.emit = (type) => events.push(type);

  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: { sendMessage: (message) => { statuses.push(message); return Promise.resolve({ ok: true }); } },
  };
  try {
    assert.equal(session.pauseTabAudioForInactiveTab(23), true);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }

  assert.equal(stopped, true);
  assert.equal(session.tabAudio, null);
  assert.equal(session.settings.targetTabId, 17);
  assert.deepEqual(videos, [null]);
  assert.deepEqual(events, ['tab-audio']);
  assert.equal(statuses[0].payload.targetTabId, null);
  assert.match(session.lastSwitchError, /点击工具栏 HOCHO 图标/);
});

test('当前仍是目标标签时不停止音轨', () => {
  const session = new CompanionSession({
    settings: { screenMode: 'screen', targetTabId: 17, voiceEnabled: true },
    character: { name: '绫', persona: '陪看伙伴' },
  });
  let stopped = false;
  session.tabAudio = { stop: () => { stopped = true; } };
  assert.equal(session.pauseTabAudioForInactiveTab(17), false);
  assert.equal(stopped, false);
});
