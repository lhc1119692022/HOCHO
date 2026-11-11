// 画面采集：
//   ScreenSource —— 每次取帧时截取用户正在看的标签页（跟随标签页切换）
//   CameraSource —— 摄像头（getUserMedia）

export class ScreenSource extends EventTarget {
  constructor({ capture = null, video = null } = {}) {
    super();
    this.capture = capture; // async () => dataUrl | null
    this.video = video; // tabCapture 的视频元素，优先于截图
    this.canvas = null;
    this.ctx2d = null;
    this.busy = false;
  }

  async start() {}

  setVideo(video) {
    this.video = video || null;
  }

  // 截不到（例如正在看 chrome:// 页面）时返回 null，跳过这一帧。
  async grabJpeg({ maxLongSide = 768, quality = 0.75 } = {}) {
    if (this.busy) return null;
    this.busy = true;
    try {
      if (this.video) {
        if (!this.video.videoWidth || !this.video.videoHeight) return null;
        return await drawToJpeg(
          this.video,
          this.video.videoWidth,
          this.video.videoHeight,
          maxLongSide,
          quality,
          this,
        );
      }
      if (!this.capture) return null;
      const dataUrl = await this.capture();
      if (!dataUrl) return null;
      const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
      try {
        return await drawToJpeg(bitmap, bitmap.width, bitmap.height, maxLongSide, quality, this);
      } finally {
        bitmap.close();
      }
    } catch {
      return null;
    } finally {
      this.busy = false;
    }
  }

  stop() {}
}

export class CameraSource extends EventTarget {
  constructor() {
    super();
    this.stream = null;
    this.video = null;
    this.canvas = null;
    this.ctx2d = null;
    this.busy = false;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 10 } },
    });
    const track = this.stream.getVideoTracks()[0];
    track?.addEventListener('ended', () => this.dispatchEvent(new Event('ended')));
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = this.stream;
    document.body.appendChild(video);
    this.video = video;
    await video.play().catch(() => {});
  }

  async grabJpeg({ maxLongSide = 768, quality = 0.75 } = {}) {
    const video = this.video;
    if (!video || this.busy) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    this.busy = true;
    try {
      return await drawToJpeg(video, vw, vh, maxLongSide, quality, this);
    } finally {
      this.busy = false;
    }
  }

  stop() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
    }
    this.video = null;
  }
}

// 画到 canvas 并编码成 JPEG。owner 上缓存 canvas 以避免反复创建。
async function drawToJpeg(source, vw, vh, maxLongSide, quality, owner) {
  const scale = Math.min(1, maxLongSide / Math.max(vw, vh));
  const w = Math.max(2, Math.round(vw * scale));
  const h = Math.max(2, Math.round(vh * scale));
  if (!owner.canvas || owner.canvas.width !== w || owner.canvas.height !== h) {
    owner.canvas = document.createElement('canvas');
    owner.canvas.width = w;
    owner.canvas.height = h;
    owner.ctx2d = owner.canvas.getContext('2d', { alpha: false });
  }
  owner.ctx2d.drawImage(source, 0, 0, w, h);
  const blob = await new Promise((resolve) => owner.canvas.toBlob(resolve, 'image/jpeg', quality));
  return blob ? { blob, width: w, height: h } : null;
}
