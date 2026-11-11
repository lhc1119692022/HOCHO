// 模型语音播放器：按 response.audio.context 配对的 PCM16 片段排队播放，并按实际播放进度产生回执。
//
// 回执（由 session 转发给服务端）：
//   chunk-completed → playback.chunk.completed（片段真正播完）
//   run-completed   → playback.completed（收到 response.audio.done 且全部片段播完）
//   stopRun() 返回值 → playback.stopped（被打断时，当前片段已播放的毫秒数）

const START_LEAD_SEC = 0.06;

export class PcmPlayer extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.output = null;
    this.sampleRate = 48000;
    this.runs = new Map();
    this.finishedRuns = new Set();
    this.nextTime = 0;
    this.active = false;
  }

  async init() {
    if (this.ctx) return;
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.output = this.ctx.createGain();
    this.output.connect(this.ctx.destination);
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
  }

  get isSuspended() {
    return this.ctx?.state === 'suspended';
  }

  resume() {
    return this.ctx?.resume();
  }

  // 下行 PCM 的采样率以 media.configured.output_audio.sample_rate 为准。
  setSourceSampleRate(rate) {
    if (Number.isFinite(rate) && rate > 0) this.sampleRate = rate;
  }

  setVolume(value) {
    if (this.output) this.output.gain.value = value;
  }

  getRun(runId, turnId) {
    let run = this.runs.get(runId);
    if (!run) {
      run = { runId, turnId, chunks: [], audioDone: false, stopped: false, finished: false };
      this.runs.set(runId, run);
    }
    if (!run.turnId && turnId) run.turnId = turnId;
    return run;
  }

  enqueue(meta, arrayBuffer) {
    if (!this.ctx) return;
    const runId = meta?.run_id || '_unpaired';
    if (this.finishedRuns.has(runId)) return;
    const run = this.getRun(runId, meta?.turn_id);
    if (run.stopped) return;

    const byteLength = arrayBuffer.byteLength - (arrayBuffer.byteLength % 2);
    const chunk = { meta, src: null, startAt: 0, duration: 0, ended: false };
    run.chunks.push(chunk);

    if (byteLength === 0) {
      this.completeChunk(run, chunk);
      return;
    }

    const samples = new Int16Array(arrayBuffer, 0, byteLength / 2);
    const buffer = this.ctx.createBuffer(1, samples.length, this.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 32768;

    const now = this.ctx.currentTime;
    if (this.nextTime < now + 0.01) this.nextTime = now + START_LEAD_SEC;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.output);
    chunk.src = src;
    chunk.startAt = this.nextTime;
    chunk.duration = buffer.duration;
    src.onended = () => this.completeChunk(run, chunk);
    src.start(chunk.startAt);
    this.nextTime = chunk.startAt + chunk.duration;
    this.setActive(true);
  }

  completeChunk(run, chunk) {
    if (chunk.ended || run.stopped) return;
    chunk.ended = true;
    if (chunk.meta?.chunk_id) {
      this.emit('chunk-completed', {
        run_id: run.runId,
        turn_id: chunk.meta.turn_id || run.turnId,
        chunk_id: chunk.meta.chunk_id,
      });
    }
    this.maybeFinishRun(run);
    this.updateActive();
  }

  markAudioDone(runId, turnId) {
    if (!runId || this.finishedRuns.has(runId)) return;
    const run = this.getRun(runId, turnId);
    run.audioDone = true;
    this.maybeFinishRun(run);
  }

  maybeFinishRun(run) {
    if (run.finished || run.stopped || !run.audioDone) return;
    if (!run.chunks.every((c) => c.ended)) return;
    run.finished = true;
    this.runs.delete(run.runId);
    this.rememberFinished(run.runId);
    if (run.runId !== '_unpaired') {
      this.emit('run-completed', { run_id: run.runId, turn_id: run.turnId });
    }
  }

  // 停止某个回复的播放。先对已经播完但还没回执的片段补发 chunk-completed，
  // 再返回 playback.stopped 需要的数据；回复不存在或已播完时返回 null。
  stopRun(runId, turnId) {
    if (!runId || this.finishedRuns.has(runId)) return null;
    const run = this.runs.get(runId);
    if (!run) {
      // 还没收到任何音频就被停止。
      this.rememberFinished(runId);
      return { run_id: runId, turn_id: turnId, played_audio_ms: 0 };
    }
    const now = this.ctx ? this.ctx.currentTime : 0;
    let playedMs = 0;
    for (const chunk of run.chunks) {
      if (chunk.ended) continue;
      if (chunk.src && now >= chunk.startAt + chunk.duration) {
        this.completeChunk(run, chunk);
      } else if (chunk.src && now >= chunk.startAt && playedMs === 0) {
        playedMs = Math.max(0, Math.round((now - chunk.startAt) * 1000));
      }
    }
    run.stopped = true;
    for (const chunk of run.chunks) {
      if (!chunk.ended && chunk.src) {
        chunk.src.onended = null;
        try {
          chunk.src.stop();
        } catch {
          // 尚未开始或已结束的节点会抛错，忽略即可。
        }
      }
    }
    this.runs.delete(runId);
    this.rememberFinished(runId);
    this.recomputeNextTime();
    this.updateActive();
    return { run_id: runId, turn_id: run.turnId || turnId, played_audio_ms: playedMs };
  }

  stopAll() {
    const results = [];
    for (const runId of [...this.runs.keys()]) {
      const result = this.stopRun(runId);
      if (result && runId !== '_unpaired') results.push(result);
    }
    return results;
  }

  reset() {
    this.stopAll();
    this.finishedRuns.clear();
    this.nextTime = 0;
  }

  rememberFinished(runId) {
    this.finishedRuns.add(runId);
    if (this.finishedRuns.size > 200) {
      const first = this.finishedRuns.values().next().value;
      this.finishedRuns.delete(first);
    }
  }

  recomputeNextTime() {
    let latest = this.ctx ? this.ctx.currentTime : 0;
    for (const run of this.runs.values()) {
      for (const chunk of run.chunks) {
        if (!chunk.ended && chunk.src) latest = Math.max(latest, chunk.startAt + chunk.duration);
      }
    }
    this.nextTime = latest;
  }

  updateActive() {
    let playing = false;
    for (const run of this.runs.values()) {
      if (run.chunks.some((c) => !c.ended && c.src)) {
        playing = true;
        break;
      }
    }
    this.setActive(playing);
  }

  setActive(active) {
    if (this.active === active) return;
    this.active = active;
    this.emit('active', { active });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async close() {
    this.reset();
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close().catch(() => {});
    this.ctx = null;
  }
}
