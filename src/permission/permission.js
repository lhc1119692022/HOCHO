// 授权页。扩展弹窗里弹不出浏览器的权限提示，offscreen 文档也不行，
// 所以在这个普通标签页里，由用户点「允许」按钮逐项触发浏览器提示。
//
//   microphone —— 麦克风（必需）
//   screen     —— 读取网页画面（<all_urls> 可选主机权限，用于跟随当前标签页截图）
//   camera     —— 摄像头（只在选了摄像头 / Auto 模式时需要）

const ALL = ['microphone', 'screen', 'camera'];
const LABELS = { microphone: '麦克风', screen: '看网页', camera: '摄像头' };
const need = (new URLSearchParams(location.search).get('need') || 'microphone')
  .split(',')
  .filter((k) => ALL.includes(k));

const hint = document.getElementById('hint');
const progress = document.getElementById('progress');
const done = document.getElementById('done');
const doneList = document.getElementById('doneList');
const finish = document.getElementById('finish');
const later = document.getElementById('later');
let announced = false;
const rows = Object.fromEntries(
  need.map((kind) => {
    const row = document.querySelector(`.item[data-perm="${kind}"]`);
    row.hidden = false;
    return [kind, { row, button: row.querySelector('.act') }];
  }),
);

const SETTINGS_URL = `chrome://settings/content/siteDetails?site=${encodeURIComponent(location.origin)}`;

async function stateOf(kind) {
  if (kind === 'screen') {
    return (await chrome.permissions.contains({ origins: ['<all_urls>'] })) ? 'granted' : 'prompt';
  }
  try {
    return (await navigator.permissions.query({ name: kind })).state;
  } catch {
    return 'prompt';
  }
}

function paint(kind, state) {
  const { button } = rows[kind];
  button.dataset.state = state;
  button.textContent = state === 'granted' ? '已允许' : state === 'denied' ? '去设置' : '允许';
}

async function refresh() {
  let granted = 0;
  for (const kind of need) {
    const state = await stateOf(kind);
    paint(kind, state);
    if (state === 'granted') granted += 1;
  }
  const all = granted === need.length;
  progress.textContent = `${need.map((kind) => LABELS[kind]).join('、')} · 已允许 ${granted} / ${need.length} 项`;
  progress.classList.toggle('ok', all);
  done.classList.toggle('show', all);
  if (all) {
    // 不再自动关页：让用户自己确认这一页的每一项是什么、是否都允许了。
    hint.textContent = '';
    doneList.textContent = `${need.map((kind) => LABELS[kind]).join('、')} 都已允许。`;
    if (!announced) {
      announced = true;
      chrome.runtime.sendMessage({ type: 'hocho:permission-result', granted: true }).catch(() => {});
    }
  } else {
    doneList.textContent = '';
  }
  return all;
}

async function request(kind) {
  hint.textContent = '';
  const state = await stateOf(kind);
  if (state === 'granted') return;
  if (state === 'denied') {
    hint.textContent = '之前被拦截过，浏览器不会再弹提示。请在打开的设置页里把它改成「允许」，再回到这里。';
    chrome.tabs.create({ url: SETTINGS_URL });
    return;
  }
  try {
    if (kind === 'screen') {
      const ok = await chrome.permissions.request({ origins: ['<all_urls>'] });
      if (!ok) hint.textContent = '没有允许「看网页」。不需要的话，可以在插件里换成摄像头模式。';
    } else {
      const stream = await navigator.mediaDevices.getUserMedia(
        kind === 'microphone' ? { audio: true } : { video: true },
      );
      stream.getTracks().forEach((t) => t.stop());
    }
  } catch (error) {
    const label = kind === 'microphone' ? '麦克风' : '摄像头';
    if (error?.name === 'NotFoundError') hint.textContent = `没有检测到${label}。`;
    else if (error?.name === 'NotReadableError') hint.textContent = `${label}被其他程序占用。`;
    else if (error?.name === 'NotAllowedError') hint.textContent = `${label}没有被允许。`;
    else hint.textContent = `授权失败：${error?.message || error}`;
  }
  await refresh();
}

async function closeSelf() {
  try {
    // 先把用户送回原来的网页，再关掉授权页，回来点插件图标就能直接开始。
    const { pendingAction } = await chrome.storage.local.get('pendingAction');
    if (Number.isInteger(pendingAction?.tabId)) {
      await chrome.tabs.update(pendingAction.tabId, { active: true }).catch(() => {});
    }
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
  } catch {
    window.close();
  }
}

for (const kind of need) {
  rows[kind].button.addEventListener('click', () => request(kind));
  if (kind !== 'screen') {
    navigator.permissions
      .query({ name: kind })
      .then((status) => status.addEventListener('change', refresh))
      .catch(() => {});
  }
}
// 只显示本页真正需要的项；否则会出现“看得见但点不动”的按钮。
for (const kind of ALL) {
  const row = document.querySelector(`.item[data-perm="${kind}"]`);
  if (row && !rows[kind]) row.hidden = true;
}
finish.addEventListener('click', () => closeSelf());
later.addEventListener('click', () => closeSelf());
// 从设置页改完权限回来时刷新一次
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

refresh();
