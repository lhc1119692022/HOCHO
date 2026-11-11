// 视频音轨 PCM 取样（第二条 MOSS Live 监听连接用）。
// 只处理标签页/窗口音频，不碰麦克风；输出 16 kHz 单声道 PCM S16LE，40ms 一帧。

class VideoPcmTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions || {};
    this.targetRate = opts.targetRate || 16000;
    const frameMs = opts.frameMs || 40;
    this.frameSamples = Math.round((this.targetRate * frameMs) / 1000);
    this.ratio = sampleRate / this.targetRate;
    this.out = new Int16Array(this.frameSamples);
    this.outIndex = 0;
    this.acc = 0;
    this.accCount = 0;
    this.phase = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    const length = channel ? channel.length : 128;
    for (let i = 0; i < length; i += 1) {
      this.acc += channel ? channel[i] : 0;
      this.accCount += 1;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        let value = this.acc / this.accCount;
        this.acc = 0;
        this.accCount = 0;
        if (value > 1) value = 1;
        else if (value < -1) value = -1;
        this.out[this.outIndex] = value < 0 ? value * 0x8000 : value * 0x7fff;
        this.outIndex += 1;
        if (this.outIndex === this.frameSamples) {
          const pcm = this.out.slice().buffer;
          this.port.postMessage({ pcm }, [pcm]);
          this.outIndex = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('hocho-video-pcm', VideoPcmTapProcessor);
