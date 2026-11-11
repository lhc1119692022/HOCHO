// MOSS-Live WebSocket 协议的最底层封装：收发 JSON 事件、带类型前缀的二进制（tagged-v1）、等待特定事件。

export const TAG_AUDIO = 0x00;
export const TAG_CAMERA = 0x01;
export const TAG_SCREEN = 0x02;

export class ConnectionClosedError extends Error {
  constructor(code, reason, wasOpened) {
    super(`连接已关闭（${code}${reason ? `：${reason}` : ''}）`);
    this.code = code;
    this.reason = reason;
    this.wasOpened = wasOpened;
  }
}

export class LiveClient extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.opened = false;
    this.waiters = new Set();
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      ws.onopen = () => {
        this.opened = true;
        settled = true;
        resolve();
      };
      ws.onerror = () => {
        // 浏览器不会暴露握手失败的 HTTP 状态码，具体原因由上层另行诊断。
      };
      ws.onclose = (event) => {
        const error = new ConnectionClosedError(event.code, event.reason, this.opened);
        this.rejectWaiters(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.dispatchEvent(
          new CustomEvent('close', {
            detail: { code: event.code, reason: event.reason, wasOpened: this.opened },
          }),
        );
      };
      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          let msg;
          try {
            msg = JSON.parse(event.data);
          } catch {
            return;
          }
          this.handleMessage(msg);
        } else {
          this.dispatchEvent(new CustomEvent('binary', { detail: event.data }));
        }
      };
    });
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get bufferedAmount() {
    return this.ws?.bufferedAmount ?? 0;
  }

  send(event) {
    if (!this.isOpen) return false;
    this.ws.send(JSON.stringify(event));
    return true;
  }

  sendTagged(tag, payload) {
    if (!this.isOpen) return false;
    const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    const packet = new Uint8Array(body.byteLength + 1);
    packet[0] = tag;
    packet.set(body, 1);
    this.ws.send(packet);
    return true;
  }

  sendAudio(pcmBuffer) {
    return this.sendTagged(TAG_AUDIO, pcmBuffer);
  }

  sendFrame(source, jpegBuffer) {
    return this.sendTagged(source === 'camera' ? TAG_CAMERA : TAG_SCREEN, jpegBuffer);
  }

  handleMessage(msg) {
    for (const waiter of [...this.waiters]) {
      if (waiter.match(msg)) {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
    }
    this.dispatchEvent(new CustomEvent('message', { detail: msg }));
  }

  // 等待第一条满足条件的服务端事件。
  waitFor(match, { timeoutMs = 10000, label = '服务端响应' } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.isOpen) {
        reject(new Error('连接未打开'));
        return;
      }
      const waiter = { match, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`等待${label}超时`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  rejectWaiters(error) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  close(code = 1000, reason = '') {
    if (!this.ws) return;
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(code, reason);
    }
  }
}

export function errorInfo(msg) {
  const err = msg?.data?.error || {};
  return { code: err.code || 'unknown_error', message: err.message || '' };
}
