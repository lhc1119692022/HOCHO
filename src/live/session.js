// 一次陪伴会话：连接、麦克风、语音播放与画面采集的编排。
//
// 运行在 offscreen 文档里，所以弹窗关闭不影响会话。
// 画面模式（screenMode）：auto = 屏幕+摄像头两路都推、由服务端决定主画面；
//                          screen = 只推屏幕；camera = 只推摄像头。

import { LiveClient, ConnectionClosedError, errorInfo } from './live-client.js';
import { MicCapture, MIC_FRAME_MS } from './mic.js';
import { PcmPlayer } from './player.js';
import { ScreenSource, CameraSource } from './frames.js';
import { TabAudioCapture } from './tab-audio.js';
import { VideoListenerClient } from './video-listener-client.js';
import {
  VideoListenerGate,
  VideoSummary,
  guessVideoType,
  buildListenerPrompt,
  formatContextLine,
  isValidVideoType,
  videoKeyFromUrl,
  proactivePrompt,
  PROACTIVE_INTERVAL_MS,
} from './video-listener.js';
import { authRule, captureVisible, reportSessionStatus, saveSettingsToBg } from '../shared/bg-bridge.js';
import { LIVE_MODEL, QUALITY_PRESETS } from '../shared/defaults.js';
import { memoryUserId, realtimeUrlFromBase } from '../shared/storage.js';
import { MossApiError, listModels } from '../shared/moss-api.js';

const MAX_RECONNECTS = 3;
const VIDEO_BUFFER_LIMIT = 512 * 1024;
const PING_INTERVAL_MS = 25000;
const MIC_ACTIVE_WINDOW_MS = 2000;

class ServerError extends Error {
  constructor(info, prefix = '服务端错误') {
    super(`${prefix}：${info.code}${info.message ? `（${info.message}）` : ''}`);
    this.code = info.code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CompanionSession extends EventTarget {
  constructor({ settings, character, muted = false, tabAudio = null }) {
    super();
    this.settings = { ...settings };
    this.character = character;
    this.voiceId = character.voiceId || null;
    this.state = 'idle';
    this.client = null;
    this.sessionId = null;
    this.connectionReady = false;
    this.stopping = false;
    this.reconnectAttempts = 0;
    this.closingInfo = null;
    this.lastCloseDetail = null;

    this.mic = null;
    this.player = null;
    this.muted = Boolean(muted);
    this.tabAudio = null;
    this.tabAudioHint = tabAudio;
    // 视频监听（第二条 MOSS Live 连接，规格 §4.3）
    this.videoGate = new VideoListenerGate();
    this.videoListener = null;
    this.videoListenerOpening = null;
    this.videoSummary = null;
    this.videoKey = '';
    this.videoTypeId = 'general';
    this.videoSampleTimer = null;
    // 视频监听连接失败后的退避：失败一次就别每 300ms 重连，否则服务端会直接断开。
    this.videoFailures = 0;
    this.videoRetryAt = 0;
    this.videoLastError = '';
    this.pendingVideoLines = [];
    this.timelineStartedAt = 0;
    this.lastMicVoiceAt = 0;
    this.voiceEnabled = settings.voiceEnabled !== false;
    this.shareVideoAudio = settings.shareVideoAudio !== false;
    this.messages = Array.isArray(settings.messages) ? settings.messages.slice(-200) : [];
    this.messageSeq = 0;
    this.lastError = '';
    // 主动评论：档位在角色上（见 get proactivity），测试通过后才生效。
    this.proactivityVerified = settings.proactivityVerified === true;
    this.lastProactiveAt = 0;
    this.sources = { screen: null, camera: null };
    this.lastGrab = { screen: -Infinity, camera: -Infinity };
    this.audioClockMs = 0;
    this.mediaConfig = null;
    this.pendingAudioContext = null;
    this.pingTimer = null;

    this.keyCounter = 0;
    this.currentUserKey = null;
    this.userKeysByTurn = new Map();
    this.acceptedUserKeys = new Set();
    this.lastAssistantKey = null;
  }

  get screenMode() {
    return this.settings.screenMode || 'screen';
  }

  // 屏幕 / Auto 模式会采集当前标签页（画面 + 视频声音），摄像头模式不采集标签页。
  get captureMode() {
    return this.screenMode === 'camera' ? 'camera' : 'tab';
  }

  // ---------- 生命周期 ----------

  async start() {
    this.setState('connecting');
    this.timelineStartedAt = performance.now();
    this.lastError = '';
    this.sessionId = this.settings.sessionId || null;
    try {
      this.player = new PcmPlayer();
      // 先把标签页声音/画面接进来（streamId 有时效），再初始化播放器和麦克风。
      if (this.captureMode === 'tab') await this.startTabAudio();
      await this.player.init();
      this.player.addEventListener('chunk-completed', (e) =>
        this.client?.send({ action: 'playback.chunk.completed', ...e.detail }),
      );
      this.player.addEventListener('run-completed', (e) =>
        this.client?.send({ action: 'playback.completed', ...e.detail }),
      );
      this.player.addEventListener('active', (e) => {
        // 她开口时把标签页里的视频音量压下去，说完再平滑恢复。
        this.tabAudio?.setDucked(e.detail.active);
        this.emit('assistant-speaking', { speaking: e.detail.active });
      });

      // 麦克风只上传用户声音；标签页声音走独立的本地监控和文字线索通道。
      this.mic = new MicCapture({
        onFrame: (pcm) => this.onMicFrame(pcm),
        onLevel: (level) => {
          if (level >= 0.01) this.lastMicVoiceAt = Date.now();
          this.emit('mic-level', { level });
        },
      });
      await this.mic.start();
      this.mic.setMuted(this.muted || !this.voiceEnabled);

      await this.applyScreenMode(this.screenMode);
      // 首次连接失败也自动重试最多 3 次（规格 §1.6 / §8.4）。
      await this.connectWithRetry();
      this.pingTimer = setInterval(() => {
        if (this.connectionReady) this.client?.send({ action: 'ping', timestamp: Date.now() });
      }, PING_INTERVAL_MS);
      this.setState('live');
      this.checkAudioUnlocked();
    } catch (error) {
      const message = await this.describeStartError(error);
      await this.teardown();
      this.setState('error', { message });
    }
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    await this.teardown();
    this.setState('ended');
  }

  async fail(message) {
    if (this.stopping) return;
    this.stopping = true;
    await this.teardown();
    this.setState('error', { message });
  }

  async teardown() {
    this.pendingVideoLines = [];
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.connectionReady = false;
    const client = this.client;
    this.client = null;
    client?.close(1000, 'client stop');
    for (const kind of ['screen', 'camera']) {
      this.sources[kind]?.stop();
      this.sources[kind] = null;
    }
    this.emit('sources', this.sourceState());
    this.stopTabAudio();
    await this.mic?.stop();
    this.mic = null;
    await this.player?.close();
    this.player = null;
    this.emit('assistant-speaking', { speaking: false });
    await authRule.remove();
  }

  // ---------- 画面模式 ----------

  // mode: auto | screen | camera
  async applyScreenMode(mode) {
    this.settings.screenMode = mode;
    const wantScreen = mode === 'auto' || mode === 'screen';
    const wantCamera = mode === 'auto' || mode === 'camera';

    // 看网页的模式才需要听标签页声音；摄像头模式不采集。
    if (wantScreen && !this.tabAudio) {
      await this.startTabAudio().catch(() => {});
    } else if (!wantScreen && this.tabAudio) {
      this.stopTabAudio();
    }

    if (wantScreen && !this.sources.screen) {
      await this.startSource('screen').catch((error) => {
        this.notice('warn', describeSourceError(error, '屏幕'));
      });
    } else if (!wantScreen && this.sources.screen) {
      await this.stopSource('screen');
    }

    if (wantCamera && !this.sources.camera) {
      await this.startSource('camera').catch((error) => {
        this.notice('warn', describeSourceError(error, '摄像头'));
      });
    } else if (!wantCamera && this.sources.camera) {
      await this.stopSource('camera');
    }
    this.emit('sources', this.sourceState());
  }

  async setScreenMode(mode, tabAudioHint = null) {
    if (tabAudioHint) this.tabAudioHint = tabAudioHint;
    await this.applyScreenMode(mode);
    if (!this.connectionReady) return;
    for (const kind of ['screen', 'camera']) {
      this.client?.send({ action: 'video.state', source: kind, enabled: Boolean(this.sources[kind]) });
    }
    this.sendFocus();
  }

  // 切到另一个网页（点插件图标，或开启了「所有网站自动跟随」）：
  // 只切采集目标，不重建 MOSS Live 会话，对话历史也保留。
  async switchTarget(tabId, url = '', title = '') {
    if (this.stopping || !Number.isInteger(tabId)) return;
    this.settings.targetTabId = tabId;
    if (url) this.settings.targetUrl = url;
    if (title) this.settings.targetTitle = title;
    if (this.captureMode !== 'tab') return;
    await this.switchTabAudio(tabId);
  }

  async startSource(kind) {
    if (this.sources[kind]) return;

    if (kind === 'camera') {
      const camera = new CameraSource();
      await camera.start();
      if (this.stopping) {
        camera.stop();
        return;
      }
      camera.addEventListener('ended', () => this.stopSource('camera'));
      this.sources.camera = camera;
      this.lastGrab.camera = -Infinity;
      return;
    }

    // 屏幕：有 tabCapture 视频轨时直接取视频帧，否则回退到截图当前标签页。
    // 截图时必须告诉后台“目标标签页是哪个”，否则切到别的网页后画面和声音会对不上。
    const screen = new ScreenSource({
      capture: this.tabAudio?.video
        ? null
        : () => captureVisible(this.settings.targetTabId ?? null).catch((error) => {
          if (error?.otherTab) this.handleOtherTab(error);
          return null;
        }),
      video: this.tabAudio?.video || null,
    });
    await screen.start();
    if (this.stopping) return;
    this.sources.screen = screen;
    this.lastGrab.screen = -Infinity;
  }

  async stopSource(kind) {
    const source = this.sources[kind];
    if (!source) return;
    source.stop();
    this.sources[kind] = null;
    if (this.connectionReady) {
      this.client?.send({ action: 'video.state', source: kind, enabled: false });
      this.sendFocus();
    }
    this.emit('sources', this.sourceState());
  }

  sourceState() {
    return { screen: Boolean(this.sources.screen), camera: Boolean(this.sources.camera) };
  }

  // ---------- 标签页声音 ----------

  createTabAudioCapture() {
    const capture = new TabAudioCapture({ onFrame: (pcm) => this.onVideoAudioFrame(pcm) });
    capture.addEventListener('audible', (e) => {
      // 视频刚开始出声时立刻补一帧，不用等到下一个取帧周期。
      if (e.detail.audible) this.lastGrab.screen = -Infinity;
      this.emit('tab-audio', { ...this.tabAudioState(), audible: e.detail.audible });
    });
    capture.addEventListener('ended', () => {
      if (this.tabAudio === capture) this.stopTabAudio();
    });
    return capture;
  }

  async startTabAudio() {
    if (this.tabAudio || this.stopping) return;
    const hint = this.tabAudioHint;
    this.tabAudioHint = null;
    const capture = this.createTabAudioCapture();
    try {
      await capture.start(hint, { withVideo: true, withAudio: true });
      if (this.stopping) {
        capture.stop();
        return;
      }
      this.tabAudio = capture;
      // 如果接入时 TA 正好在说话，立刻保持压低状态。
      capture.setDucked(Boolean(this.player?.active));
      if (this.shareVideoAudio) this.setupVideoContext(capture);
      this.startVideoSampling();
      this.emit('tab-audio', this.tabAudioState());
    } catch (error) {
      // 标签页声音是增强项：没有它也能正常聊天，所以不打断会话。
      console.warn('[HOCHO] tab audio unavailable', error);
      this.notice('warn', '这次没接到标签页里的声音，只能听到麦克风。');
    }
  }

  // 用户切换标签页时，把“听视频”的那一路跟着切过去（画面本来就会跟随当前标签页）。
  async switchTabAudio(tabId) {
    if (this.stopping || this.captureMode !== 'tab' || !Number.isInteger(tabId)) return;
    if (!this.tabAudio) {
      this.tabAudioHint = { tabId };
      await this.startTabAudio();
      this.sources.screen?.setVideo?.(this.tabAudio?.video || null);
      return;
    }
    if (this.tabAudio.tabId === tabId) return;
    const previous = this.tabAudio;
    const capture = this.createTabAudioCapture();
    try {
      await capture.start({ tabId }, { withVideo: true, withAudio: true });
      if (this.stopping) {
        capture.stop();
        return;
      }
      this.clearVideoContext();
      this.tabAudio = capture;
      capture.setDucked(Boolean(this.player?.active));
      if (this.shareVideoAudio) this.setupVideoContext(capture);
      previous.stop();
      this.sources.screen?.setVideo?.(capture.video || null);
      this.emit('tab-audio', this.tabAudioState());
    } catch (error) {
      capture.stop();
      console.warn('[HOCHO] switch tab audio failed', error);
    }
  }

  stopTabAudio() {
    this.clearVideoContext();
    this.stopVideoSampling();
    if (!this.tabAudio) return;
    this.sources.screen?.setVideo?.(null);
    this.tabAudio.stop();
    this.tabAudio = null;
    this.emit('tab-audio', this.tabAudioState());
  }

  // ---------- 视频监听（第二条 MOSS Live 连接，规格 §4.3） ----------

  // 视频声音不进用户语音通道；监听结果只通过 session.thinking.append 静默注入主会话。
  setupVideoContext(capture) {
    // 按视频网址区分：重新打开同一个视频时能接上之前的摘要；拿不到网址时退回按标签页区分。
    const tabId = capture?.tabId || this.settings.targetTabId || 0;
    this.videoKey = videoKeyFromUrl(capture?.url || this.settings.targetUrl || '') || `tab-${tabId}`;
    const overrides = this.settings.videoTypeByKey || {};
    const saved = overrides[this.videoKey];
    this.videoTypeId = isValidVideoType(saved)
      ? saved
      : guessVideoType({
        title: capture?.title || this.settings.targetTitle || '',
        url: capture?.url || this.settings.targetUrl || '',
      });
    const summaries = this.settings.videoSummaries || {};
    this.videoSummary = VideoSummary.restore(summaries[this.videoKey])
      || new VideoSummary({ videoKey: this.videoKey, typeId: this.videoTypeId });
    this.videoSummary.typeId = this.videoTypeId;
    this.videoGate.reset();
    this.emit('video-type', { typeId: this.videoTypeId, videoKey: this.videoKey });
  }

  setVideoType(typeId) {
    if (!isValidVideoType(typeId)) return;
    this.videoTypeId = typeId;
    if (this.videoSummary) this.videoSummary.typeId = typeId;
    const overrides = { ...(this.settings.videoTypeByKey || {}), [this.videoKey]: typeId };
    this.settings.videoTypeByKey = overrides;
    saveSettingsToBg({ videoTypeByKey: overrides }).catch(() => {});
    // 提示词随类型变化，重建监听连接
    this.closeVideoListener();
    this.videoGate.detach();
    this.emit('video-type', { typeId, videoKey: this.videoKey });
  }

  onVideoAudioFrame(pcm) {
    this.videoListener?.sendAudio(pcm);
  }

  startVideoSampling() {
    if (this.videoSampleTimer) return;
    this.videoSampleTimer = setInterval(() => this.sampleVideoGate(), 150);
  }

  stopVideoSampling() {
    clearInterval(this.videoSampleTimer);
    this.videoSampleTimer = null;
  }

  sampleVideoGate() {
    if (this.stopping || !this.shareVideoAudio || !this.tabAudio) return;
    // 主连接连好之后再开监听连接：两条连接共用主连接装好的鉴权规则。
    if (!this.connectionReady) return;
    // 失败退避期间不重连。等真的到了重试时间再放开闸门。
    const now = performance.now();
    if (this.videoFailures > 0) {
      if (now < this.videoRetryAt) return;
      this.videoGate.detach();
    }
    const decision = this.videoGate.sample(Boolean(this.tabAudio.audible), now);
    if (decision === 'start') this.openVideoListener();
    else if (decision === 'stop') this.closeVideoListener();
  }

  async openVideoListener() {
    if (this.videoListener || this.videoListenerOpening || this.stopping) return;
    const prompt = buildListenerPrompt({
      typeId: this.videoTypeId,
      personaPrompt: this.character.persona || '',
      videoKey: this.videoKey,
    });
    // 监听连接是独立的新会话，不带长期记忆的 user 参数，免得视频内容写进用户记忆。
    const listener = new VideoListenerClient({
      url: this.buildUrl({ withUser: false }),
      prompt,
      quality: this.settings.videoQuality,
    });
    this.videoListenerOpening = listener;
    listener.addEventListener('transcript', (e) => this.onVideoListenerTranscript(e.detail));
    listener.addEventListener('error', (e) => {
      this.videoLastError = `${e.detail.code || ''}${e.detail.message ? `：${e.detail.message}` : ''}`;
      console.warn('[HOCHO] video listener error', e.detail);
    });
    listener.addEventListener('close', (e) => {
      if (this.videoListener !== listener) return;
      this.videoListener = null;
      this.videoGate.detach();
      this.emit('tab-audio', this.tabAudioState());
      // 连上之后被断开（不是我们主动关的）：也算一次失败，避免立刻又连。
      if (!this.stopping && this.shareVideoAudio) this.scheduleVideoRetry(e.detail);
    });
    try {
      await listener.connect();
      if (this.stopping || this.videoListenerOpening !== listener) {
        listener.close();
        return;
      }
      this.videoListener = listener;
      this.videoListenerOpening = null;
      this.videoFailures = 0;
      this.videoRetryAt = 0;
      this.videoLastError = '';
      // 重连时把本地滚动摘要和最近关键台词补回上下文。
      const replay = this.videoSummary?.replayText();
      if (replay) this.injectVideoContext(replay);
      this.emit('tab-audio', this.tabAudioState());
    } catch (error) {
      this.videoListenerOpening = null;
      this.videoGate.detach();
      console.warn('[HOCHO] video listener connect failed', error);
      this.scheduleVideoRetry({ lastEvent: error?.message });
    }
  }

  // 监听连接失败：退避重试 3 次；还不行就说明这条链接不通，给出可见提示后停手。
  scheduleVideoRetry(detail) {
    this.videoFailures += 1;
    this.videoRetryAt = performance.now() + 2000 * 2 ** (this.videoFailures - 1);
    if (this.videoFailures <= 3) {
      this.notice('warn', `视频监听连接断开，${Math.round((this.videoRetryAt - performance.now()) / 1000)} 秒后重试（${this.videoFailures}/3）。`);
      return;
    }
    // 重试用完：关掉听视频，不再重连，并把原因说清楚。
    this.shareVideoAudio = false;
    this.settings.shareVideoAudio = false;
    this.clearVideoContext();
    this.stopVideoSampling();
    saveSettingsToBg({ shareVideoAudio: false, videoListenUnavailable: true }).catch(() => {});
    const why = detail?.lastError || this.videoLastError || detail?.reason || (detail?.code ? `WebSocket ${detail.code}` : '');
    this.notice(
      'error',
      `「听视频」这条连接一直连不上（${why || '未知原因'}），已自动关闭。TA 现在只能看画面、听你说话。可以过一会儿在底部重新打开。`,
    );
    this.emit('tab-audio', this.tabAudioState());
  }

  closeVideoListener() {
    const listener = this.videoListener || this.videoListenerOpening;
    this.videoListener = null;
    this.videoListenerOpening = null;
    listener?.close();
    this.emit('tab-audio', this.tabAudioState());
  }

  onVideoListenerTranscript({ text, final }) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean || !final) return; // 只取 final，避免同一句重复注入
    const atSec = this.timelineStartedAt ? (performance.now() - this.timelineStartedAt) / 1000 : 0;
    const content = formatContextLine({
      atSec,
      typeId: this.videoTypeId,
      facts: clean,
      summary: this.videoSummary?.summary || '',
    });
    this.videoSummary?.append({ facts: clean, atMs: performance.now() });
    this.persistVideoSummary();
    this.injectVideoContext(content);
    this.maybeProactiveComment(clean);
  }

  persistVideoSummary() {
    if (!this.videoSummary || !this.videoKey) return;
    const summaries = {
      ...(this.settings.videoSummaries || {}),
      [this.videoKey]: this.videoSummary.snapshot(),
    };
    this.settings.videoSummaries = summaries;
    saveSettingsToBg({ videoSummaries: summaries }).catch(() => {});
  }

  // 切换陪看目标：清空旧视频上下文，保留主会话和聊天历史（规格 §8.3）。
  clearVideoContext() {
    this.videoGate.reset();
    this.videoSummary = null;
    this.videoKey = '';
    this.videoTypeId = 'general';
    this.closeVideoListener();
  }

  // ---------- 主动评论 ----------
  // 角色能力：由主连接（当前角色的声音）开口。档位存在角色上，在角色编辑里改。
  // 需要先在角色编辑里点「测试」，确认 MOSS 会照着做，才真正生效。

  get proactivity() {
    const value = this.character?.proactivity;
    return ['quiet', 'normal', 'lively'].includes(value) ? value : 'normal';
  }

  setProactivityVerified(value) {
    this.proactivityVerified = Boolean(value);
    if (!this.proactivityVerified) this.lastProactiveAt = 0;
  }

  canProactivelySpeak() {
    // 优先级：用户说话 > 主 Agent 回答 > 主动评论（规格 §5.2）。
    if (!this.connectionReady || !this.client || this.stopping) return false;
    if (this.micActiveRecently()) return false;
    if (this.player?.active) return false;
    return true;
  }

  maybeProactiveComment(videoContext) {
    // 真实协议验证未通过前，不向服务端发送主动播报请求；逻辑保留，验证后打开开关即可。
    if (!this.proactivityVerified) return;
    if (!this.canProactivelySpeak()) return;
    const now = Date.now();
    if (now - this.lastProactiveAt < (PROACTIVE_INTERVAL_MS[this.proactivity] || 25000)) return;
    this.lastProactiveAt = now;
    this.client.send({
      action: 'session.commentary.append',
      content: proactivePrompt(videoContext),
      event_id: `proactive-${now}-${Math.random().toString(36).slice(2, 8)}`,
    });
  }

  injectVideoContext(content) {
    const text = String(content || '').trim().slice(0, 2000);
    if (!text) return;
    if (!this.connectionReady || !this.client) {
      this.pendingVideoLines.push(text);
      if (this.pendingVideoLines.length > 20) this.pendingVideoLines.shift();
      return;
    }
    // 走“事实/进度”通道，不进入用户语音轨，也不会让模型以为这是用户说的话。
    this.client.send({
      action: 'session.thinking.append',
      content: text,
      event_id: `video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  }

  flushVideoTranscripts() {
    if (!this.connectionReady || !this.client) return;
    const lines = this.pendingVideoLines.splice(0);
    for (const content of lines) {
      this.client.send({
        action: 'session.thinking.append',
        content,
        event_id: `video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
    }
  }

  tabAudioState() {
    return {
      active: Boolean(this.tabAudio?.active),
      audible: Boolean(this.tabAudio?.audible),
      enabled: Boolean(this.shareVideoAudio),
      // 视频监听连接已经连上，正在把视频内容告诉 TA
      transcribing: Boolean(this.videoListener),
      typeId: this.videoTypeId,
      videoKey: this.videoKey,
    };
  }

  // auto 模式把选择权交给服务端；单路时明确告知服务端看哪一路。
  sendFocus() {
    if (!this.connectionReady || !this.client) return;
    const active = ['screen', 'camera'].filter((k) => this.sources[k]);
    if (active.length === 0) return;
    if (this.screenMode === 'auto') {
      this.client.send({ action: 'video.stream_focus', source: 'auto' });
      return;
    }
    if (active.length === 1) {
      this.client.send({ action: 'video.stream_focus', source: active[0] });
    }
  }

  // ---------- 连接与配置 ----------

  async connectWithRetry() {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RECONNECTS; attempt += 1) {
      if (this.stopping) throw lastError || new Error('连接已取消');
      const resume = attempt === 0 && Boolean(this.sessionId);
      try {
        await this.openConnection({ resume });
        this.reconnectAttempts = 0;
        return;
      } catch (error) {
        lastError = error;
        this.lastCloseDetail = error?.code ? { code: error.code, reason: error.reason || '' } : this.lastCloseDetail;
        if (resume) this.sessionId = null; // 保存的 session_id 可能已过期
        if (attempt < MAX_RECONNECTS) {
          this.setState('reconnecting', { attempt: attempt + 1 });
          this.notice('warn', `连接失败，正在重试（${attempt + 1}/${MAX_RECONNECTS}）…`);
          await sleep(1000 * 2 ** attempt);
        }
      }
    }
    throw lastError;
  }

  buildUrl({ withUser = true } = {}) {
    const url = new URL(realtimeUrlFromBase(this.settings.apiBase));
    url.searchParams.set('model', this.settings.selectedModel || LIVE_MODEL);
    if (withUser && this.settings.memoryEnabled) {
      url.searchParams.set('user', memoryUserId(this.settings, this.character.id));
    }
    return url.toString();
  }

  async openConnection({ resume }) {
    const url = this.buildUrl();
    try {
      await authRule.install(this.settings.apiKey, url);
    } catch (error) {
      throw new Error(`无法准备鉴权：${error.message}`);
    }

    const client = new LiveClient(url);
    this.client = client;
    this.connectionReady = false;
    client.addEventListener('message', (e) => this.onServerEvent(client, e.detail));
    client.addEventListener('binary', (e) => this.onServerBinary(client, e.detail));
    client.addEventListener('close', (e) => this.onClose(client, e.detail));

    try {
      await client.connect();
      const attach = { action: 'attach_session', session_id: resume ? this.sessionId : null };
      if (this.settings.memoryEnabled) attach.memory_scope = 'user';
      client.send(attach);
      const attached = await client.waitFor(
        (m) => m.action === 'session_attached' || m.action === 'error',
        { label: '会话建立', timeoutMs: 15000 },
      );
      if (attached.action === 'error') throw new ServerError(errorInfo(attached), '会话建立失败');
      this.sessionId = attached.data?.session_id || null;
      // 把 session_id 持久化，页面/offscreen 重启后仍可用于断线恢复。
      if (this.sessionId) saveSettingsToBg({ sessionId: this.sessionId }).catch(() => {});
      await this.configure(client);
      this.connectionReady = true;
      this.flushVideoTranscripts();
    } catch (error) {
      if (this.client === client) this.client = null;
      client.close(1000, 'setup failed');
      throw error;
    }
  }

  async configure(client) {
    const wait = (actions, label, timeoutMs = 10000) =>
      client.waitFor((m) => actions.includes(m.action) || m.action === 'error', { label, timeoutMs });

    if (this.voiceId) {
      client.send({ action: 'change_voice', voice_name: this.voiceId });
      const res = await wait(['voice_changed'], '音色切换', 8000).catch(() => null);
      if (res?.action !== 'voice_changed') this.notice('warn', '音色没设置成功，先用默认音色。');
    }

    client.send({ action: 'session.update', session: this.sessionConfig() });
    const updated = await wait(['session.updated'], '人设配置');
    if (updated.action === 'error') throw new ServerError(errorInfo(updated), '人设配置失败');
    if (updated.data?.error) throw new Error(`人设配置失败：${updated.data.error}`);

    client.send({ action: 'media.mode', binary_protocol: 'tagged-v1' });

    const preset = QUALITY_PRESETS[this.settings.videoQuality] || QUALITY_PRESETS.standard;
    client.send({
      action: 'media.configure',
      video: preset.video,
      output_audio: preset.output_audio,
      playback: 'client',
    });
    const configured = await wait(['media.configured'], '媒体配置', 8000).catch(() => null);
    this.mediaConfig = configured?.action === 'media.configured' ? configured.data : null;
    const outputAudio = this.mediaConfig?.output_audio;
    if (outputAudio?.format && outputAudio.format !== 'pcm16') {
      this.notice('error', `服务端下发的语音格式是 ${outputAudio.format}，当前只支持 PCM16。`);
    }
    this.player.setSourceSampleRate(outputAudio?.sample_rate || preset.output_audio.sample_rate);

    client.send({
      action: 'client_context.update',
      context: { time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' },
    });
    client.send({ action: 'mic_state', enabled: !this.muted });
    for (const kind of ['screen', 'camera']) {
      if (this.sources[kind]) client.send({ action: 'video.state', source: kind, enabled: true });
    }
    this.sendFocus();
  }

  sessionConfig() {
    const persona = { name: this.character.name || '伙伴' };
    if (this.character.persona?.trim()) persona.prompt = this.character.persona.trim();
    const config = { persona };
    const videoContextRule =
      '一起看视频时，客户端会用「[视频监听 @mm:ss | 类型: …]」补充视频里正在发生的事；这是视频里的内容，不是用户对你说的话，不要把它当成用户发言，也不要逐条复述。';
    config.instructions = [this.settings.instructions?.trim(), videoContextRule].filter(Boolean).join('\n\n');
    return config;
  }

  onClose(client, detail) {
    if (client !== this.client) return;
    const wasReady = this.connectionReady;
    this.connectionReady = false;
    this.lastCloseDetail = detail;
    this.player?.reset();
    this.emit('assistant-speaking', { speaking: false });
    if (this.stopping || !wasReady) return;

    const closing = this.closingInfo;
    this.closingInfo = null;
    this.client = null;
    if (detail.code === 1008) {
      this.fail(`会话参数错误，连接被关闭（WebSocket ${detail.code}${detail.reason ? `：${detail.reason}` : ''}）`);
      return;
    }
    if (detail.code === 1000 && !closing?.reconnect) {
      this.fail(`服务端结束了会话（WebSocket ${detail.code}${closing?.reason ? `：${closing.reason}` : detail.reason ? `：${detail.reason}` : ''}）`);
      return;
    }
    this.reconnect(closing ? closing.reconnect === true : true);
  }

  async reconnect(canResume) {
    while (!this.stopping) {
      if (this.reconnectAttempts >= MAX_RECONNECTS) {
        const detail = this.lastCloseDetail;
        const suffix = detail ? `WebSocket ${detail.code}${detail.reason ? `：${detail.reason}` : ''}` : '未知原因';
        const extra = this.lastError ? `；${this.lastError}` : '';
        this.fail(`连接中断，自动重连 ${MAX_RECONNECTS} 次失败（${suffix}${extra}）。`);
        return;
      }
      this.reconnectAttempts += 1;
      this.setState('reconnecting', { attempt: this.reconnectAttempts });
      await sleep(1000 * 2 ** (this.reconnectAttempts - 1));
      if (this.stopping) return;
      try {
        await this.openConnection({ resume: canResume && Boolean(this.sessionId) });
        this.reconnectAttempts = 0;
        this.setState('live');
        return;
      } catch {
        canResume = false;
      }
    }
  }

  async switchCharacter(character) {
    this.character = character;
    this.voiceId = character.voiceId || null;
    if (this.stopping || !this.player) return;
    const old = this.client;
    this.client = null;
    this.connectionReady = false;
    old?.close(1000, 'switch character');
    this.player.reset();
    this.sessionId = null;
    this.setState('connecting');
    try {
      await this.openConnection({ resume: false });
      this.setState('live');
    } catch (error) {
      this.fail(`切换角色失败：${error.message}`);
    }
  }

  async setVoice(voiceId) {
    this.voiceId = voiceId || null;
    const client = this.client;
    if (!this.connectionReady || !client || !voiceId) return;
    client.send({ action: 'change_voice', voice_name: voiceId });
    const res = await client
      .waitFor((m) => m.action === 'voice_changed' || m.action === 'error', {
        label: '音色切换',
        timeoutMs: 8000,
      })
      .catch(() => null);
    if (res?.action !== 'voice_changed') this.notice('warn', '音色切换失败。');
  }

  setMuted(muted) {
    this.muted = muted;
    this.mic?.setMuted(muted);
    if (this.connectionReady) this.client?.send({ action: 'mic_state', enabled: !muted });
  }

  setVoiceEnabled(enabled) {
    this.voiceEnabled = Boolean(enabled);
    this.settings.voiceEnabled = this.voiceEnabled;
    this.setMuted(!this.voiceEnabled);
  }

  setShareVideoAudio(enabled) {
    this.shareVideoAudio = Boolean(enabled);
    this.settings.shareVideoAudio = this.shareVideoAudio;
    if (!this.shareVideoAudio) {
      this.clearVideoContext();
      this.stopVideoSampling();
    } else if (this.tabAudio) {
      this.setupVideoContext(this.tabAudio);
      this.startVideoSampling();
    }
    this.emit('tab-audio', this.tabAudioState());
  }

  async setCameraEnabled(enabled) {
    this.settings.cameraEnabled = Boolean(enabled);
    if (enabled && !this.sources.camera) {
      await this.startSource('camera').catch((error) => this.notice('warn', describeSourceError(error, '摄像头')));
    } else if (!enabled && this.sources.camera) {
      await this.stopSource('camera');
    }
    this.sendFocus();
    this.emit('sources', this.sourceState());
  }

  resumeAudio() {
    this.player?.resume();
    this.mic?.resume();
  }

  checkAudioUnlocked() {
    setTimeout(() => {
      if (this.player?.isSuspended || this.mic?.isSuspended) this.emit('needs-gesture', {});
    }, 300);
  }

  // ---------- 推流 ----------

  videoParams() {
    const preset = QUALITY_PRESETS[this.settings.videoQuality] || QUALITY_PRESETS.standard;
    const params = { ...preset.video, ...(this.mediaConfig?.video || {}) };
    // 视频正在出声时稍微提高取帧频率，让画面和声音更同步；没有声音时保持服务端配置。
    if (this.tabAudio?.audible && params.interval_ms > 750) params.interval_ms = 750;
    return params;
  }

  // 用麦克风帧当时钟驱动截帧：offscreen 文档的定时器不受后台节流影响较小，但仍以音频为准最稳。
  onMicFrame(pcm) {
    this.audioClockMs += MIC_FRAME_MS;
    const client = this.client;
    if (!this.connectionReady || !client?.isOpen) return;
    client.sendAudio(pcm);

    const params = this.videoParams();
    for (const kind of ['screen', 'camera']) {
      const source = this.sources[kind];
      if (!source) continue;
      if (this.audioClockMs - this.lastGrab[kind] < params.interval_ms) continue;
      this.lastGrab[kind] = this.audioClockMs;
      this.captureAndSend(kind, source, params, client);
    }
  }

  async captureAndSend(kind, source, params, client) {
    try {
      const frame = await source.grabJpeg({
        maxLongSide: params.max_long_side,
        quality: params.jpeg_quality,
      });
      if (!frame || client !== this.client || !client.isOpen) return;
      if (client.bufferedAmount > VIDEO_BUFFER_LIMIT) return;
      client.sendFrame(kind, await frame.blob.arrayBuffer());
    } catch (error) {
      console.warn('[HOCHO] frame capture failed', error);
    }
  }

  // ---------- 服务端事件 ----------

  onServerEvent(client, msg) {
    if (client !== this.client) return;
    const data = msg.data || {};
    switch (msg.action) {
      case 'input.speech.started':
        if (!this.muted && this.voiceEnabled) this.lastMicVoiceAt = Date.now();
        this.emit('user-speaking', { speaking: true });
        break;
      case 'input.speech.stopped':
        this.emit('user-speaking', { speaking: false });
        break;
      case 'input.transcript.updated':
        this.onUserTranscript(data, false);
        break;
      case 'input.transcript.done':
        this.onUserTranscript(data, true);
        break;
      case 'input.transcript.revised': {
        const key = this.userKeysByTurn.get(data.turn);
        if (key && this.acceptedUserKeys.has(key)) {
          this.emit('transcript', { role: 'user', key, text: data.text || '', final: true });
          this.upsertMessage({
            id: `user-${key}`,
            role: 'user',
            text: String(data.text || '').trim(),
            final: true,
            at: Date.now(),
          });
        }
        break;
      }
      case 'output.transcript.updated':
      case 'output.transcript.done':
        this.onAssistantTranscript(data, msg.action === 'output.transcript.done');
        break;
      case 'response.audio.context':
        this.pendingAudioContext = data;
        break;
      case 'response.audio.done':
        this.player?.markAudioDone(data.run_id, data.turn_id);
        break;
      case 'response.audio.stop':
        this.stopPlayback(data.run_id, data.turn_id);
        break;
      case 'response.interrupted':
        this.stopPlayback(data.run_id, data.turn_id);
        if (data.text) {
          this.emit('transcript', {
            role: 'assistant',
            key: this.assistantKey(data),
            text: data.text,
            final: true,
            interrupted: true,
          });
          this.onAssistantTranscript({ ...data, text: data.text }, true, true);
        }
        break;
      case 'response.ended':
        if (data.run_id && data.run_id === this.lastAssistantKey) this.lastAssistantKey = null;
        break;
      case 'session.closing':
        this.closingInfo = data;
        break;
      case 'error': {
        const info = errorInfo(msg);
        this.lastError = `${info.code}${info.message ? `：${info.message}` : ''}`;
        this.notice('error', this.lastError);
        break;
      }
      default:
        break;
    }
  }

  onServerBinary(client, buffer) {
    if (client !== this.client) return;
    const meta = this.pendingAudioContext;
    this.pendingAudioContext = null;
    this.player?.enqueue(meta, buffer);
  }

  stopPlayback(runId, turnId) {
    const result = this.player?.stopRun(runId, turnId);
    if (result) this.client?.send({ action: 'playback.stopped', ...result });
  }

  micActiveRecently() {
    return this.voiceEnabled && !this.muted && Date.now() - this.lastMicVoiceAt < MIC_ACTIVE_WINDOW_MS;
  }

  upsertMessage(message) {
    const index = this.messages.findIndex((m) => m.id === message.id);
    if (index >= 0) this.messages[index] = { ...this.messages[index], ...message };
    else {
      this.messages.push(message);
      if (this.messages.length > 500) this.messages.shift();
    }
    if (message.final) saveSettingsToBg({ messages: this.messages.slice(-200) }).catch(() => {});
    this.emit('message', message);
  }

  onUserTranscript(data, final) {
    let key = data.turn ? this.userKeysByTurn.get(data.turn) : null;
    if (!key) key = this.currentUserKey || `u-${(this.keyCounter += 1)}`;
    this.currentUserKey = final ? null : key;
    if (data.turn) {
      this.userKeysByTurn.set(data.turn, key);
      if (this.userKeysByTurn.size > 300) {
        this.userKeysByTurn.delete(this.userKeysByTurn.keys().next().value);
      }
    }
    // 只记你真说过的话：最近 2 秒内麦克风确实有声音，这句转写才显示成「你」说的。
    // 外放的视频声、环境噪音被识别出来的字不显示。同一句一旦确认是你说的，后续更新照常显示。
    if (!this.acceptedUserKeys.has(key)) {
      if (!this.micActiveRecently()) return;
      this.acceptedUserKeys.add(key);
      if (this.acceptedUserKeys.size > 300) {
        this.acceptedUserKeys.delete(this.acceptedUserKeys.values().next().value);
      }
    }
    this.emit('transcript', { role: 'user', key, text: data.text || '', final });
    const text = String(data.text || '').trim();
    if (!text) return;
    this.upsertMessage({
      id: `user-${key}`,
      role: 'user',
      text,
      final,
      at: Date.now(),
    });
  }

  onAssistantTranscript(data, final, interrupted = false) {
    const runId = this.assistantKey(data);
    this.emit('transcript', {
      role: 'assistant',
      key: runId,
      text: data.text || '',
      final,
      interrupted,
    });
    const id = `assistant-${runId}`;
    const text = String(data.text || '').trim();
    const existing = this.messages.find((m) => m.id === id);
    if (!text && existing) {
      this.upsertMessage({ ...existing, final, interrupted });
      return;
    }
    if (!text) return;
    this.upsertMessage({
      id,
      role: 'assistant',
      text,
      final,
      interrupted,
      runId,
      at: Date.now(),
    });
  }

  assistantKey(data) {
    if (data.run_id) {
      this.lastAssistantKey = data.run_id;
      return data.run_id;
    }
    if (!this.lastAssistantKey) this.lastAssistantKey = `a-${(this.keyCounter += 1)}`;
    return this.lastAssistantKey;
  }

  // ---------- 工具 ----------

  async describeStartError(error) {
    if (error?.name === 'NotAllowedError') return '麦克风没有授权。';
    if (error?.name === 'NotFoundError') return '没有找到可用的麦克风。';
    if (error?.name === 'NotReadableError') return '麦克风被其他程序占用。';
    if (error instanceof ConnectionClosedError && error.wasOpened) {
      if (error.code === 1013) return '实时服务繁忙，稍后再试。';
      const extra = this.lastError ? `；${this.lastError}` : '';
      return `连接被服务端关闭（WebSocket ${error.code}${error.reason ? `：${error.reason}` : ''}${extra}）`;
    }
    if (error instanceof ConnectionClosedError) {
      // 浏览器拿不到握手的 HTTP 状态码，用普通接口校验一次 Key 来区分原因。
      try {
        await listModels({ apiKey: this.settings.apiKey, apiBase: this.settings.apiBase });
      } catch (verifyError) {
        if (verifyError instanceof MossApiError) return verifyError.message;
        return '连不上 MOSS 服务，检查一下网络。';
      }
      const model = this.settings.selectedModel || LIVE_MODEL;
      return `实时连接被拒绝（WebSocket ${error.code}${error.reason ? `：${error.reason}` : ''}）。普通 API 校验通过，但实时模型握手失败：请确认这个 Key 有 moss-live-1.0 的实时权限，并检查模型名（当前 ${model}）和网络代理。`;
    }
    return error?.message || String(error);
  }

  // 用户切到了别的网页：画面暂时看不到陪看中的那一页。
  // 只提示一次，避免每秒一条；切回来会自动恢复。
  handleOtherTab(error) {
    if (this.otherTabNoticed) return;
    this.otherTabNoticed = { title: error?.title || '' };
    this.emit('other-tab', { showing: error?.title || '', target: this.settings.targetTitle || '' });
    this.notice('warn', '你现在看的不是陪看中的那个网页，TA 暂时看不到画面（声音还在听）。');
  }

  setState(state, extra = {}) {
    this.state = state;
    this.emit('state', { state, ...extra });
    // 让后台画图标角标：哪个网页在陪看、哪个没生效、有没有出错。
    reportSessionStatus({
      state,
      targetTabId: Number.isInteger(this.settings.targetTabId) ? this.settings.targetTabId : null,
    });
  }

  notice(level, text) {
    this.emit('notice', { level, text, at: Date.now() });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

function describeSourceError(error, label) {
  if (error?.name === 'NotAllowedError') return `${label}权限被拒绝。`;
  if (error?.name === 'NotFoundError') return `没有找到可用的${label}。`;
  if (error?.name === 'NotReadableError') return `${label}被其他程序占用。`;
  return `${label}启动失败：${error?.message || error}`;
}
