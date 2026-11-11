// 第二条 MOSS Live 连接：视频监听。
//
// 它只做「视频感知」：接收视频声音，输出事实/台词/人物/剧情和摘要，不对用户说话。
// 输出由 session.js 通过 session.thinking.append 静默注入主会话。
//
// 关键：这里的连接配置（media.configure）必须和主连接一致——主连接是已验证可用的路径。
// 之前用了 input_audio + playback:'server' 这套没验证过的组合，服务端会直接断开（1006）。

import { LiveClient, TAG_AUDIO, errorInfo } from './live-client.js';
import { QUALITY_PRESETS } from '../shared/defaults.js';

export class VideoListenerClient extends EventTarget {
  constructor({ url, prompt, quality = 'standard', label = '视频监听' } = {}) {
    super();
    this.url = url;
    this.prompt = prompt;
    this.quality = quality;
    this.label = label;
    this.client = null;
    this.ready = false;
    this.closed = false;
    this.lastEvent = '';
    this.lastError = '';
  }

  async connect() {
    const client = new LiveClient(this.url);
    this.client = client;
    client.addEventListener('message', (e) => this.onMessage(e.detail));
    client.addEventListener('binary', () => {
      // 监听连接不需要它的语音，收下就丢。
    });
    client.addEventListener('close', (e) => {
      this.ready = false;
      if (this.closed) return;
      this.dispatchEvent(new CustomEvent('close', { detail: { ...e.detail, lastEvent: this.lastEvent, lastError: this.lastError } }));
    });

    try {
      await client.connect();
      client.send({ action: 'attach_session', session_id: null, memory_scope: 'session' });
      await this.wait(['session_attached'], '视频监听会话建立', 15000);

      client.send({
        action: 'session.update',
        session: {
          persona: { name: '视频感知层', prompt: this.prompt },
          instructions: '只输出视频感知结果。不要向用户说话、不要提问、不要给建议。输出保持简短。',
        },
      });
      const updated = await this.wait(['session.updated'], '视频监听人设配置', 10000);
      if (updated.data?.error) throw new Error(`视频监听配置失败：${updated.data.error}`);

      client.send({ action: 'media.mode', binary_protocol: 'tagged-v1' });

      // 和主连接同样的字段：只有 output_audio + playback，不带 video、不带 input_audio。
      const preset = QUALITY_PRESETS[this.quality] || QUALITY_PRESETS.standard;
      client.send({
        action: 'media.configure',
        output_audio: preset.output_audio,
        playback: 'client',
      });
      const configured = await this.wait(['media.configured'], '视频监听媒体配置', 8000);
      if (configured.data?.error) throw new Error(`视频监听媒体配置失败：${configured.data.error}`);

      client.send({ action: 'mic_state', enabled: true });
      this.ready = true;
      this.dispatchEvent(new Event('ready'));
      return true;
    } catch (error) {
      const detail = this.lastEvent ? `（最后一个事件：${this.lastEvent}）` : '';
      this.close();
      throw new Error(`${error?.message || error}${detail}`);
    }
  }

  // 等到期望的事件；收到 error 事件就立刻失败，并把服务端说的话带出来。
  async wait(actions, label, timeoutMs) {
    const msg = await this.client.waitFor(
      (m) => actions.includes(m.action) || m.action === 'error',
      { label, timeoutMs },
    );
    if (msg.action === 'error') {
      const info = errorInfo(msg);
      throw new Error(`${label}失败：${info.code}${info.message ? `（${info.message}）` : ''}`);
    }
    return msg;
  }

  onMessage(msg) {
    if (this.closed) return;
    this.lastEvent = msg.action;
    const data = msg.data || {};
    switch (msg.action) {
      case 'output.transcript.updated':
      case 'output.transcript.done':
        this.dispatchEvent(new CustomEvent('transcript', {
          detail: { text: data.text || '', final: msg.action === 'output.transcript.done' },
        }));
        break;
      case 'response.audio.done':
        // 我们没有真的播放。为了让服务端认为这一轮已经播完，立刻回一个完成回执。
        this.client?.send({
          action: 'playback.completed',
          run_id: data.run_id,
          turn_id: data.turn_id,
          played_audio_ms: 0,
        });
        break;
      case 'error': {
        const info = errorInfo(msg);
        this.lastError = `${info.code}${info.message ? `：${info.message}` : ''}`;
        this.dispatchEvent(new CustomEvent('error', { detail: info }));
        break;
      }
      case 'session.closing':
        this.dispatchEvent(new CustomEvent('closing', { detail: data }));
        break;
      default:
        break;
    }
  }

  sendAudio(pcm) {
    if (!this.ready || !this.client?.isOpen) return;
    this.client.sendTagged(TAG_AUDIO, pcm);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.client?.close(1000, 'video listener stop');
    this.client = null;
  }
}
