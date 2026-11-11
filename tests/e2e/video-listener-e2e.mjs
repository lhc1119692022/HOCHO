// 第二条 MOSS Live 视频监听连接（「听视频」）的协议级 e2e。
// 直接连本地模拟 MOSS 服务器，验证：建连配置、视频声音上行、文本输出、关闭。
// 插件里鉴权头由 declarativeNetRequest 规则加上；Node 里用带请求头的 WebSocket 模拟同样效果。
import { createMockServer, TEST_KEY } from './mock-server.mjs';
import { createChecker, sleep } from './harness.mjs';

const MOCK_PORT = 18893;
const { check, summary } = createChecker();
const { WebSocket: NodeWebSocket } = await import('ws');
globalThis.WebSocket = class extends NodeWebSocket {
  constructor(url) {
    super(url, { headers: { Authorization: `Bearer ${TEST_KEY}` } });
  }
};

const mock = createMockServer({ port: MOCK_PORT });
await mock.listen();

try {  const { VideoListenerClient } = await import('../../src/live/video-listener-client.js');
  const { buildListenerPrompt } = await import('../../src/live/video-listener.js');
  const prompt = buildListenerPrompt({ typeId: 'series', personaPrompt: '绫的人设', videoKey: 'tab-7' });

  const listener = new VideoListenerClient({
    url: `ws://127.0.0.1:${MOCK_PORT}/v1/realtime?model=moss-live-1.0`,
    prompt,
  });
  const transcripts = [];  listener.addEventListener('transcript', (e) => transcripts.push(e.detail));
  await listener.connect();
  await sleep(250); // 等最后一帧配置事件到达模拟服务器

  check('视频监听连接建立', listener.ready === true);
  check('监听连接带上 Authorization', mock.log.some(
    (e) => e.type === 'ws-handshake' && e.auth === `Bearer ${TEST_KEY}`,
  ));
  check('监听握手不带 Origin', mock.log.some(
    (e) => e.type === 'ws-handshake' && e.origin === null,
  ));

  const events = mock.log.filter((e) => e.type === 'client-event').map((e) => e.action);
  check('按 MOSS Live 协议顺序配置', ['attach_session', 'session.update', 'media.mode', 'media.configure', 'mic_state']
    .every((action) => events.includes(action)), events.join(' → '));

  const attach = mock.log.find((e) => e.type === 'client-event' && e.action === 'attach_session');
  check('监听连接是独立新会话（不带主 session_id）', attach?.msg?.session_id == null, JSON.stringify(attach?.msg));
  check('监听连接使用 session 级记忆', attach?.msg?.memory_scope === 'session');

  const update = mock.log.find((e) => e.type === 'client-event' && e.action === 'session.update');
  const listenerPrompt = update?.msg?.session?.persona?.prompt || '';
  check('监听提示词限定为感知层，不对用户说话', listenerPrompt.includes('不要对用户说话') && listenerPrompt.includes('不要扮演评论者'));
  check('监听提示词带当前角色人设与视频类型', listenerPrompt.includes('绫的人设') && listenerPrompt.includes('连续剧/电影'));

  const configure = mock.log.find((e) => e.type === 'client-event' && e.action === 'media.configure');
  check('监听连接的配置和主连接一致（不推画面）', !('video' in (configure?.msg || {})));
  check(
    '监听连接不请求服务端播放（收到语音就丢，不占播放通道）',
    configure?.msg?.playback === 'client' && !('input_audio' in (configure?.msg || {})),
    JSON.stringify(configure?.msg),
  );

  // 模拟视频声音上行：0x00 标签的音频帧
  const pcm = new Uint8Array([1, 2, 3, 4]).buffer;
  listener.sendAudio(pcm);
  await sleep(300);
  check('视频声音以 0x00 音频帧上行', (mock.sessions[0]?.audioBytes || 0) >= 4,
    String(mock.sessions[0]?.audioBytes || 0));

  // 模拟服务端输出视频感知结果
  mock.sessions[0].send({
    action: 'output.transcript.updated',
    data: { text: '主角在雨中接到电话', run_id: 'v1', turn_id: 't1' },
  });
  mock.sessions[0].send({
    action: 'output.transcript.done',
    data: { text: '主角在雨中接到电话，镜头切到旧照片。', run_id: 'v1', turn_id: 't1' },
  });
  await sleep(300);
  check('监听连接产出视频感知文本', transcripts.some((t) => t.final && t.text.includes('旧照片')),
    JSON.stringify(transcripts));

  listener.close();
  await sleep(300);
  check('监听连接可正常关闭', mock.log.some((e) => e.type === 'ws-closed'));
} catch (error) {
  check('视频监听 e2e 异常', false, error.stack || error.message);
} finally {
  const failed = summary();
  await mock.close();
  process.exit(failed ? 1 : 0);
}
