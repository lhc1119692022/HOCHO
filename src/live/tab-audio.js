// 标签页声音采集：把用户正在看的那个标签页的声音接进来。
//
// 重要：视频声音不能混进麦克风上行。MOSS-Live 一条连接只接一个说话人，
// 混音会让服务端把视频里的声音也当成“用户在说话”。这里的标签页声音只用于：
//   1. 在本机回放给用户（tabCapture 接管后原标签页会静音）；
//   2. 判断视频是否在出声，用于 TA 说话时压低音量；
//   3. 交给 video-transcript.js 识别成文字线索，再静默发给模型。
//
// 注意：offscreen 不能直接调用 chrome.tabCapture，streamId 由后台（或弹窗）
// 通过 getMediaStreamId 取得，再交给这里用 getUserMedia({ chromeMediaSource: 'tab' }) 打开。

// 她或你说话时把视频压下去，但不要压到听不见：保留 40%，人声还听得清背景。
const DUCK_LEVEL = 0.4;
const DUCK_DOWN_SEC = 0.12;
const DUCK_UP_SEC = 0.28;
const AUDIBLE_RMS = 0.004;

export class TabAudioCapture extends EventTarget {
  constructor({ duckLevel = DUCK_LEVEL, volume = 1, onFrame = null } = {}) {
    super();
    this.duckLevel = duckLevel;
    // 用户自己调的视频音量倍率（1 = 原样）。设备/系统差异导致偏小时可以调大。
    this.volume = volume;
    this.onFrame = onFrame; // (pcm16 ArrayBuffer) => void，供第二条 MOSS Live 监听连接上行
    this.tapNode = null;
    this.stream = null;
    this.video = null;
    this.ctx = null;
    this.source = null;
    this.gain = null;
    this.analyser = null;
    this.levelData = null;
    this.audible = false;
    this.ducked = false;
    this.timer = null;
    this.tabId = null;
    this.title = '';
    this.lastAudibleAt = 0; // performance.now() 的绝对毫秒值，由会话统一换算成时间轴
  }

  get active() {
    return Boolean(this.stream);
  }

  // streamInfo: 弹窗提前拿到的 { streamId, tabId, title }，或切换标签页时的 { tabId }；
  // 没有 streamId 时再向后台要一次。
  async start(streamInfo = null, { withVideo = false, withAudio = true } = {}) {
    const info = streamInfo?.streamId ? streamInfo : await requestTabAudio(streamInfo?.tabId);
    if (!info?.streamId) throw new Error('没有拿到标签页声音的采集许可');

    const base = {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: info.streamId,
      },
    };
    const constraints = {
      audio: withAudio ? base : false,
      video: withVideo
        ? { mandatory: { ...base.mandatory, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 5 } }
        : false,
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      if (!withVideo) throw error;
      // 某些 DRM/受保护页面不允许视频轨；声音采集仍要继续。
      console.warn('[HOCHO] tab video track unavailable, fallback to audio only', error);
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: withAudio ? base : false,
        video: false,
      });
    }
    this.tabId = info.tabId ?? null;
    this.title = info.title || '';
    this.url = info.url || '';
    this.lastAudibleAt = 0;

    try {
      for (const track of this.stream.getTracks()) {
        track.addEventListener('ended', () => this.dispatchEvent(new Event('ended')), { once: true });
      }

      const videoTrack = this.stream.getVideoTracks()[0];
      if (videoTrack) {
        this.video = document.createElement('video');
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.autoplay = true;
        this.video.srcObject = this.stream;
        this.video.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;pointer-events:none';
        document.body.appendChild(this.video);
        await this.video.play().catch(() => {});
      }

      if (this.stream.getAudioTracks().length > 0) {
        this.ctx = new AudioContext({ latencyHint: 'interactive' });
        this.source = this.ctx.createMediaStreamSource(this.stream);
        this.gain = this.ctx.createGain();
        this.gain.gain.value = this.targetGain();
        this.source.connect(this.gain).connect(this.ctx.destination);

        // 用来判断视频是否真的有声音：界面显示「在听视频」，也供会话判断媒体活跃度。
        // analyser 必须接到一个 0 音量出口，浏览器才会持续拉取它的数据。
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 512;
        this.levelData = new Float32Array(this.analyser.fftSize);
        const monitor = this.ctx.createGain();
        monitor.gain.value = 0;
        this.source.connect(this.analyser).connect(monitor).connect(this.ctx.destination);
        this.timer = setInterval(() => this.sample(), 150);

        // 把视频音轨降采样成 16 kHz PCM16，交给第二条监听连接上行；
        // 接到 0 音量出口只是为了让 worklet 持续被调度，不会重复放出声音。
        if (this.onFrame) {
          await this.ctx.audioWorklet.addModule(chrome.runtime.getURL('src/live/video-pcm-worklet.js'));
          this.tapNode = new AudioWorkletNode(this.ctx, 'hocho-video-pcm', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: { targetRate: 16000, frameMs: 40 },
          });
          this.tapNode.port.onmessage = (event) => {
            if (event.data?.pcm) this.onFrame(event.data.pcm);
          };
          const tapSink = this.ctx.createGain();
          tapSink.gain.value = 0;
          this.source.connect(this.tapNode).connect(tapSink).connect(this.ctx.destination);
        }

        if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
      }
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  // 当前的输出增益：用户音量 × （说话时压到 duckLevel）。
  targetGain() {
    return this.volume * (this.ducked ? this.duckLevel : 1);
  }

  // 用户调整视频音量（0~2）：实时生效，正在压低时也按新音量重算。
  setVolume(volume) {
    const value = Number(volume);
    if (!Number.isFinite(value) || value < 0) return;
    this.volume = value;
    if (!this.gain || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setTargetAtTime(this.targetGain(), now, 0.02);
  }

  // 她说话时压低视频音量；说完平滑恢复。
  setDucked(ducked) {
    if (this.ducked === ducked) return;
    this.ducked = ducked;
    if (!this.gain || !this.ctx) return;
    const now = this.ctx.currentTime;
    const target = this.targetGain();
    const duration = ducked ? DUCK_DOWN_SEC : DUCK_UP_SEC;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(target, now + duration);
  }

  sample() {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.levelData);
    let sum = 0;
    for (let i = 0; i < this.levelData.length; i += 1) sum += this.levelData[i] * this.levelData[i];
    const rms = Math.sqrt(sum / this.levelData.length);
    const audible = rms >= AUDIBLE_RMS;
    if (audible) this.lastAudibleAt = performance.now();
    if (audible !== this.audible) {
      this.audible = audible;
      this.dispatchEvent(new CustomEvent('audible', { detail: { audible } }));
    }
  }

  // 最近一次“视频真的有声音”的时间点（performance.now() 毫秒），用于给视频文字线索打时间戳。
  getAudibleAt() {
    return this.lastAudibleAt;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.audible = false;
    this.ducked = false;
    this.analyser = null;
    this.levelData = null;
    this.lastAudibleAt = 0;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
    }
    this.video = null;
    if (this.tapNode) {
      this.tapNode.port.onmessage = null;
      try {
        this.tapNode.disconnect();
      } catch {
        // 已断开时忽略。
      }
    }
    this.tapNode = null;
    this.source = null;
    this.gain = null;
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
    this.ctx = null;
  }
}

// offscreen 里没有 tabs / tabCapture，向后台要 streamId。
export async function requestTabAudio(tabId = null) {
  let res;
  try {
    res = await chrome.runtime.sendMessage({
      target: 'bg',
      type: 'tab-audio-stream',
      ...(Number.isInteger(tabId) ? { payload: { tabId } } : {}),
    });
  } catch (error) {
    throw new Error(`请求标签页声音失败：${error?.message || error}`);
  }
  if (!res?.ok || !res.streamId) {
    throw new Error(res?.error || '后台没有返回标签页声音采集流');
  }
  return res;
}
