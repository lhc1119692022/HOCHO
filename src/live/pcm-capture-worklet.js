// AudioWorklet：把麦克风音频降采样成 16 kHz 单声道 PCM S16LE，每 40 ms 发一帧给主线程。
// 静音（muted）时照常按实时速度输出全 0 帧——MOSS-Live 需要持续的静音来判断停顿。
// 这里只处理麦克风；视频声音走独立的文字线索通道，不混入用户语音。

class HochoPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions || {};
    this.targetRate = opts.targetRate || 16000;
    const frameMs = opts.frameMs || 40;
    this.frameSamples = Math.round((this.targetRate * frameMs) / 1000);
    // sampleRate 是 AudioWorkletGlobalScope 的全局变量（上下文的实际采样率）。
    this.ratio = sampleRate / this.targetRate;
    this.out = new Int16Array(this.frameSamples);
    this.outIndex = 0;
    this.acc = 0;
    this.accCount = 0;
    this.phase = 0;
    this.levelSum = 0;
    this.muted = false;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'mute') this.muted = Boolean(event.data.muted);
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    const length = channel ? channel.length : 128;
    for (let i = 0; i < length; i += 1) {
      // 简单的盒式滤波降采样：把一个输出样本周期内的输入取平均，足够用于语音。
      this.acc += channel ? channel[i] : 0;
      this.accCount += 1;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        let value = this.muted ? 0 : this.acc / this.accCount;
        this.acc = 0;
        this.accCount = 0;
        if (value > 1) value = 1;
        else if (value < -1) value = -1;
        this.levelSum += value * value;
        this.out[this.outIndex] = value < 0 ? value * 0x8000 : value * 0x7fff;
        this.outIndex += 1;
        if (this.outIndex === this.frameSamples) {
          const pcm = this.out.slice().buffer;
          const level = Math.sqrt(this.levelSum / this.frameSamples);
          this.port.postMessage({ pcm, level }, [pcm]);
          this.outIndex = 0;
          this.levelSum = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('hocho-pcm-capture', HochoPcmCaptureProcessor);
