// 测试公共部分：准备插件副本、启动无头 Chrome、通过 CDP（--remote-debugging-pipe）驱动。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  const chrome =
    process.env.CHROME_PATH ||
    [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
    ].find((p) => p && fs.existsSync(p));
  if (!chrome) throw new Error('找不到 Chrome，请设置 CHROME_PATH');
  return chrome;
}

// 复制一份插件到工作目录。extraHosts 追加主机权限；grantAllUrls 把可选的 <all_urls> 直接设为已授予。
export function prepareExtension({ src, dir, extraHosts = [], grantAllUrls = false }) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(src, dir, {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(src, p);
      return !rel.startsWith('.git') && !rel.startsWith('tests') && !rel.startsWith('node_modules');
    },
  });
  const file = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.host_permissions.push(...extraHosts);
  if (grantAllUrls) {
    manifest.host_permissions.push('<all_urls>');
    delete manifest.optional_host_permissions;
  }
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return dir;
}

export async function launchChrome({ profile, startUrl = 'about:blank', fakeUi = true, extraArgs = [] }) {
  fs.rmSync(profile, { recursive: true, force: true });
  const args = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--lang=zh-CN',
  ];
  if (fakeUi) args.push('--use-fake-ui-for-media-stream');
  args.push(...extraArgs, startUrl);
  const proc = spawn(findChrome(), args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

  const pipeOut = proc.stdio[3];
  const logs = [];
  const created = [];
  const pending = new Map();
  let raw = '';
  let nextId = 1;
  proc.stdio[4].on('data', (chunk) => {
    raw += chunk.toString('utf8');
    let idx;
    while ((idx = raw.indexOf('\0')) >= 0) {
      const msg = JSON.parse(raw.slice(0, idx));
      raw = raw.slice(idx + 1);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ''}`));
        else resolve(msg.result);
      } else if (msg.method === 'Target.targetCreated') {
        created.push(msg.params.targetInfo.url);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        logs.push(`[exception] ${d.exception?.description || d.text}`);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        logs.push(`[error] ${msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
      }
    }
  });

  function cdp(method, params = {}, sessionId) {
    const id = nextId++;
    pipeOut.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  }

  async function evaluate(sessionId, expression, { gesture = false } = {}) {
    const r = await cdp(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: gesture },
      sessionId,
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  async function attach(targetId) {
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Runtime.enable', {}, sessionId);
    return sessionId;
  }

  async function openTarget(url) {
    const { targetId } = await cdp('Target.createTarget', { url });
    return { targetId, sessionId: await attach(targetId) };
  }

  async function findTarget(predicate) {
    const { targetInfos } = await cdp('Target.getTargets');
    return targetInfos.find(predicate) || null;
  }

  async function bringToFront(urlPrefix) {
    const target = await findTarget((t) => t.url.startsWith(urlPrefix));
    if (!target) return;
    const sessionId = await attach(target.targetId);
    await cdp('Page.bringToFront', {}, sessionId);
  }

  async function close() {
    try {
      await cdp('Browser.close');
    } catch {}
    setTimeout(() => proc.kill(), 1000);
  }

  await cdp('Target.setDiscoverTargets', { discover: true });
  return { cdp, evaluate, attach, openTarget, findTarget, bringToFront, close, logs, created };
}

export async function waitUntil(fn, { timeout = 12000, interval = 120, label = '' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await sleep(interval);
  }
  throw new Error(`等待超时：${label}（最后：${JSON.stringify(last)}）`);
}

export function createChecker() {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  };
  const summary = () => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n==== ${results.length - failed}/${results.length} 通过 ====`);
    return failed;
  };
  return { check, summary };
}
