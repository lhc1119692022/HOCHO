// 麦克风采集：getUserMedia → AudioWorklet → 16 kHz PCM16 帧。
//
// 注意：MOSS-Live 的一条连接只接一个说话人，所以这里只上传麦克风。
// 标签页里的视频声音绝不能混进来，否则服务端会把视频里的声音也当成“用户在说话”。

export const MIC_FRAME_MS = 40;

export class MicCapture {
  constructor({ onFrame, onLevel } = {}) {
    this.onFrame = onFrame;
    this.onLevel = onLevel;
    this.stream = null;
    this.ctx = null;
    this.node = null;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    try {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      await this.ctx.audioWorklet.addModule(chrome.runtime.getURL('src/live/pcm-capture-worklet.js'));
      const source = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, 'hocho-pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { targetRate: 16000, frameMs: MIC_FRAME_MS },
      });
      this.node.port.onmessage = (event) => {
        const { pcm, level } = event.data || {};
        if (pcm) this.onFrame?.(pcm);
        if (typeof level === 'number') this.onLevel?.(level);
      };
      // 接到一个音量为 0 的节点再到 destination，保证 worklet 持续被调度，同时不会把麦克风声音放出来。
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      source.connect(this.node).connect(sink).connect(this.ctx.destination);
      if (this.ctx.state === 'suspended') await this.ctx.resume();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  get isSuspended() {
    return this.ctx?.state === 'suspended';
  }

  resume() {
    return this.ctx?.resume();
  }

  setMuted(muted) {
    this.node?.port.postMessage({ type: 'mute', muted });
  }

  async stop() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.node) this.node.port.onmessage = null;
    this.node = null;
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close().catch(() => {});
    this.ctx = null;
  }
}
