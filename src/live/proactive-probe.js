// 主动评论测试：用你填的 Key 开一条临时的 MOSS Live 连接，
// 假装视频里发生了一件事，再请 TA 主动接一句，看 MOSS 会不会照做、说了什么。
// 在弹窗的角色编辑里点「测试」时运行，大约 10 秒，会消耗少量额度。

import { LiveClient, errorInfo } from './live-client.js';
import { formatContextLine, proactivePrompt } from './video-listener.js';
import { installAuthRule } from '../shared/auth-rule.js';
import { realtimeUrlFromBase } from '../shared/storage.js';
import { LIVE_MODEL } from '../shared/defaults.js';

const SAMPLE_EVENT = '主角在雨里接到一个电话，挂断后盯着一张旧照片很久没说话。';

export async function probeProactiveComment({ apiKey, apiBase, model, character, timeoutMs = 15000 }) {
  const url = new URL(realtimeUrlFromBase(apiBase));
  url.searchParams.set('model', model || LIVE_MODEL);
  await installAuthRule({ apiKey, realtimeUrl: url.toString() });

  const client = new LiveClient(url.toString());
  const wait = (actions, label, ms = 10000) =>
    client.waitFor((m) => actions.includes(m.action) || m.action === 'error', { label, timeoutMs: ms });
  try {
    await client.connect();
    client.send({ action: 'attach_session', session_id: null, memory_scope: 'session' });
    const attached = await wait(['session_attached'], '会话建立', 15000);
    if (attached.action === 'error') return { ok: false, error: `会话建立失败：${errorInfo(attached).code}` };

    const persona = { name: character?.name || '伙伴' };
    if (character?.persona?.trim()) persona.prompt = character.persona.trim();
    client.send({
      action: 'session.update',
      session: { persona, instructions: '你在陪用户一起看视频，说话口语化、简短。' },
    });
    const updated = await wait(['session.updated'], '人设配置');
    if (updated.action === 'error' || updated.data?.error) {
      return { ok: false, error: `人设配置失败：${updated.data?.error || errorInfo(updated).code}` };
    }
    client.send({ action: 'media.mode', binary_protocol: 'tagged-v1' });
    client.send({ action: 'media.configure', playback: 'server' });
    await wait(['media.configured'], '媒体配置', 8000).catch(() => null);

    client.send({
      action: 'session.thinking.append',
      content: formatContextLine({ atSec: 12, typeId: 'series', facts: SAMPLE_EVENT }),
      event_id: `probe-thinking-${Date.now()}`,
    });
    client.send({
      action: 'session.commentary.append',
      content: proactivePrompt(SAMPLE_EVENT),
      event_id: `probe-commentary-${Date.now()}`,
    });

    const done = await wait(['output.transcript.done'], 'TA 主动开口', timeoutMs).catch(() => null);
    if (!done) return { ok: false, error: 'MOSS 没有主动开口：等了 15 秒没有任何回应。' };
    if (done.action === 'error') return { ok: false, error: `MOSS 返回错误：${errorInfo(done).code}` };
    const text = String(done.data?.text || '').trim();
    if (!text) return { ok: false, error: 'MOSS 回应了，但没有说出内容。' };
    return { ok: true, text, sample: SAMPLE_EVENT };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    client.close(1000, 'probe done');
  }
}
