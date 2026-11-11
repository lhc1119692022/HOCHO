// 模拟 MOSS-Live 的本地服务器：HTTP（/v1/models、/v1/audio/voices）+ 最小 WebSocket 实现。
import http from 'node:http';
import crypto from 'node:crypto';

export const TEST_KEY = 'test-key-123';

export function createMockServer({ port }) {
  const log = [];
  const sessions = [];
  const record = (type, data = {}) => {
    const entry = { t: Date.now(), type, ...data };
    log.push(entry);
    return entry;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const auth = req.headers.authorization || null;
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/v1/models' || url.pathname === '/v1/audio/voices') {
      record('http', { path: url.pathname, auth });
      if (auth !== `Bearer ${TEST_KEY}`) return json(401, { error: { message: 'invalid key' } });
      if (url.pathname === '/v1/models') return json(200, { data: [{ id: 'moss-live-1.0' }, { id: 'moss-vl-realtime-1.0' }] });
      return json(200, { object: 'list', data: [{ id: 'voice-clone-1', object: 'audio.voice', name: '我的克隆音色', created_at: 1 }], has_more: false });
    }
    if (url.pathname === '/page.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>probe</title><script>
        const ws = new WebSocket('ws://' + location.host + '/v1/realtime?model=moss-live-1.0&probe=page');
        ws.onopen = () => document.title = 'opened';
        ws.onclose = (e) => document.title = 'closed:' + e.code;
      </script>`);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const auth = req.headers.authorization || null;
    const entry = record('ws-handshake', {
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      auth,
      origin: req.headers.origin || null,
    });
    if (url.pathname !== '/v1/realtime' || auth !== `Bearer ${TEST_KEY}`) {
      entry.rejected = 'auth';
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // 与真实 MOSS 服务器一致：带 Origin 头的握手一律 403（浏览器直连会被拒）。
    if (req.headers.origin) {
      entry.rejected = 'origin';
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'),
    );
    const session = new MockLiveSession(new WsConn(socket), record, sessions.length + 1);
    sessions.push(session);
  });

  return {
    log,
    sessions,
    record,
    listen: () => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    current: () => sessions[sessions.length - 1],
  };
}

class WsConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.closed = false;
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => {
      this.closed = true;
      this.onclose?.(this.closeCode ?? 1006);
    });
    socket.on('error', () => {});
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const frame = this.parse();
      if (!frame) break;
      this.handleFrame(frame);
    }
  }
  parse() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      len = Number(b.readBigUInt64BE(2));
      off = 10;
    }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null;
    const payload = Buffer.from(b.subarray(off, off + len));
    if (mask) for (let i = 0; i < len; i += 1) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + len);
    return { fin, op, payload };
  }
  handleFrame({ fin, op, payload }) {
    if (op === 0x8) {
      this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      if (!this.closeSent) this.sendRaw(0x8, payload.subarray(0, 2));
      this.socket.end();
      return;
    }
    if (op === 0x9) return this.sendRaw(0xa, payload);
    if (op === 0xa) return;
    if (op === 0x0) {
      this.frag.parts.push(payload);
      if (fin) {
        const { op: fop, parts } = this.frag;
        this.frag = null;
        this.deliver(fop, Buffer.concat(parts));
      }
      return;
    }
    if (!fin) {
      this.frag = { op, parts: [payload] };
      return;
    }
    this.deliver(op, payload);
  }
  deliver(op, payload) {
    if (op === 1) this.ontext?.(payload.toString('utf8'));
    else if (op === 2) this.onbinary?.(payload);
  }
  sendRaw(op, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }
  sendJson(obj) {
    this.sendRaw(1, Buffer.from(JSON.stringify(obj)));
  }
  sendBinary(buf) {
    this.sendRaw(2, buf);
  }
  close(code = 1000, reason = '') {
    const p = Buffer.alloc(2 + Buffer.byteLength(reason));
    p.writeUInt16BE(code, 0);
    p.write(reason, 2);
    this.closeSent = true;
    this.closeCode = code;
    this.sendRaw(8, p);
    setTimeout(() => this.socket.end(), 100);
  }
}

function jpegSize(buf) {
  // buf 已去掉 1 字节前缀
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return { width: 0, height: 0 };
}

function sinePcm(ms, rate = 48000, freq = 440) {
  const n = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 6000), i * 2);
  return b;
}

class MockLiveSession {
  constructor(conn, record, index) {
    this.conn = conn;
    this.record = record;
    this.index = index;
    this.attached = false;
    this.audioBytes = 0;
    this.audioPackets = 0;
    this.firstAudioAt = 0;
    this.frames = { screen: 0, camera: 0 };
    this.lastFrame = { screen: null, camera: null };
    this.badPackets = 0;
    this.outputRate = 48000;
    this.greeted = false;
    this.received = [];
    conn.ontext = (text) => this.onText(text);
    conn.onbinary = (buf) => this.onBinary(buf);
    conn.onclose = (code) => record('ws-closed', { session: index, code });
  }

  send(obj) {
    this.conn.sendJson(obj);
  }

  onText(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.record('bad-json', { session: this.index, text });
      return;
    }
    this.received.push(msg);
    this.record('client-event', { session: this.index, action: msg.action, msg });
    const a = msg.action;
    if (!this.attached && a !== 'attach_session') {
      this.send({ action: 'error', data: { type: 'error', error: { code: 'invalid_request', message: 'first message must be attach_session' } } });
      this.conn.close(1008, 'Invalid session option');
      return;
    }
    switch (a) {
      case 'attach_session':
        this.attached = true;
        this.send({ action: 'session_attached', data: { session_id: msg.session_id || 'sess-1', memory_scope: msg.memory_scope || 'session', delegation: 'none' } });
        break;
      case 'change_voice':
        this.send({ action: 'voice_changed', data: { name: msg.voice_name } });
        break;
      case 'session.update':
        this.send({ action: 'session.updated', data: { error: '', tools: [] } });
        break;
      case 'media.configure': {
        this.outputRate = msg.output_audio?.sample_rate || 48000;
        this.send({
          action: 'media.configured',
          data: {
            profile: 'custom',
            output_audio: { format: 'pcm16', sample_rate: this.outputRate, channels: 1, framing: 's16le' },
            input_audio: { format: 'pcm16', sample_rate: 16000, channels: 1, framing: 's16le' },
            video: msg.video || { max_long_side: 512, jpeg_quality: 0.75, interval_ms: 1000 },
            playback: msg.playback || 'client',
            available: {},
            error: '',
          },
        });
        break;
      }
      case 'client_context.update':
        this.send({ action: 'client_context.updated', data: { accepted: true, error: '' } });
        break;
      case 'ping':
        this.send({ action: 'pong', data: { client_timestamp: msg.timestamp, server_recv_timestamp: Date.now() } });
        break;
      case 'session.thinking.append':
        this.send({ action: 'session.thinking.appended', data: { type: 'session.thinking.appended', client_event_id: msg.event_id || '' } });
        break;
      case 'session.commentary.append':
        // 模拟：服务端收到可向用户表达的内容后，主连接主动说一句。
        this.send({ action: 'session.commentary.appended', data: { type: 'session.commentary.appended', client_event_id: msg.event_id || '' } });
        this.send({ action: 'output.transcript.updated', data: { text: '这段挺有意思', run_id: 'rc', turn_id: 'tc' } });
        this.send({ action: 'output.transcript.done', data: { text: '这段挺有意思的。', run_id: 'rc', turn_id: 'tc' } });
        this.send({ action: 'response.ended', data: { run_id: 'rc', turn_id: 'tc', status: 'completed' } });
        break;
      default:
        break;
    }
  }

  onBinary(buf) {
    const tag = buf[0];
    const body = buf.subarray(1);
    if (tag === 0x00) {
      if (!this.firstAudioAt) this.firstAudioAt = Date.now();
      this.audioBytes += body.length;
      this.audioPackets += 1;
      if (!this.greeted && this.audioBytes >= 32000) {
        this.greeted = true;
        this.record('scenario', { session: this.index, name: 'greeting' });
        this.playScenario('greeting');
      }
    } else if (tag === 0x01 || tag === 0x02) {
      const kind = tag === 0x01 ? 'camera' : 'screen';
      this.frames[kind] += 1;
      const size = jpegSize(body);
      this.lastFrame[kind] = { bytes: body.length, ...size };
      if (this.frames[kind] === 1) this.record('first-frame', { session: this.index, kind, bytes: body.length, size });
      if (!size) this.badPackets += 1;
    } else {
      this.badPackets += 1;
      this.record('bad-binary', { session: this.index, tag });
    }
  }

  async sendAudioRun({ runId, turnId, chunks, chunkMs }) {
    this.send({ action: 'response.audio.started', data: { run_id: runId, turn_id: turnId } });
    for (let i = 1; i <= chunks; i += 1) {
      this.send({ action: 'response.audio.context', data: { run_id: runId, turn_id: turnId, chunk_id: String(i) } });
      this.conn.sendBinary(sinePcm(chunkMs, this.outputRate));
    }
  }

  async playScenario(name) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (name === 'greeting') {
      this.send({ action: 'input.speech.started', data: {} });
      this.send({ action: 'input.transcript.updated', data: { text: '你好' } });
      await wait(100);
      this.send({ action: 'input.transcript.done', data: { text: '你好呀', turn: '1' } });
      this.send({ action: 'input.speech.stopped', data: {} });
      this.send({ action: 'output.transcript.updated', data: { text: '嗨，', run_id: 'r1', turn_id: 't1' } });
      await this.sendAudioRun({ runId: 'r1', turnId: 't1', chunks: 3, chunkMs: 200 });
      this.send({ action: 'output.transcript.done', data: { text: '嗨，我在呢。', run_id: 'r1', turn_id: 't1' } });
      this.send({ action: 'response.audio.done', data: { run_id: 'r1', turn_id: 't1' } });
      this.send({ action: 'response.ended', data: { run_id: 'r1', turn_id: 't1', status: 'completed' } });
    } else if (name === 'interrupt') {
      this.send({ action: 'output.transcript.updated', data: { text: '这是一段很长的回答', run_id: 'r2', turn_id: 't2' } });
      await this.sendAudioRun({ runId: 'r2', turnId: 't2', chunks: 10, chunkMs: 200 });
      await wait(500);
      this.send({ action: 'response.audio.stop', data: { run_id: 'r2', turn_id: 't2', reason: 'barge_in' } });
      this.send({ action: 'response.interrupted', data: { run_id: 'r2', turn_id: 't2', text: '这是一段很长的', reason: 'user_speech' } });
    } else if (name === 'second') {
      this.send({ action: 'output.transcript.updated', data: { text: '第二段回答', run_id: 'r2', turn_id: 't2' } });
      await this.sendAudioRun({ runId: 'r2', turnId: 't2', chunks: 1, chunkMs: 120 });
      this.send({ action: 'output.transcript.done', data: { text: '第二段回答。', run_id: 'r2', turn_id: 't2' } });
      this.send({ action: 'response.audio.done', data: { run_id: 'r2', turn_id: 't2' } });
      this.send({ action: 'response.ended', data: { run_id: 'r2', turn_id: 't2', status: 'completed' } });
    } else if (name === 'drop') {
      this.send({ action: 'session.closing', data: { code: 1001, reason: 'server draining (test)', reconnect: true } });
      await wait(50);
      this.conn.close(1001, 'going away');
    }
  }
}
