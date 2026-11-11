// 把 icons/icon.svg 渲染成多尺寸 PNG（Chrome 图标必须用 PNG）。
// 用已经装好的无头 Chrome 截图实现，不引入额外依赖。
// 用法：node tools/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../tests/e2e/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SVG = path.join(ROOT, 'icons', 'icon.svg');
const OUT = path.join(ROOT, 'icons');
const SIZES = [16, 32, 48, 128];
const WORK = path.join(os.tmpdir(), 'hocho-icons');

const svg = fs.readFileSync(SVG, 'utf8');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

const chrome = findChrome();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const size of SIZES) {
  const page = path.join(WORK, `icon-${size}.html`);
  // 背景透明，只画图标本体；尺寸严格等于目标像素。
  fs.writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:transparent}
      svg{display:block;width:${size}px;height:${size}px}
    </style>${svg}`,
  );
  const shot = path.join(WORK, `icon-${size}.png`);
  const proc = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--default-background-color=00000000',
    `--window-size=${size},${size}`,
    `--screenshot=${shot}`,
    `file:///${page.replace(/\\/g, '/')}`,
  ], { stdio: 'ignore' });
  await new Promise((resolve) => proc.on('exit', resolve));
  await sleep(80);
  if (!fs.existsSync(shot)) throw new Error(`${size}px 渲染失败`);
  fs.copyFileSync(shot, path.join(OUT, `icon${size}.png`));
  console.log(`icon${size}.png  ${fs.statSync(shot).size} bytes`);
}

fs.rmSync(WORK, { recursive: true, force: true });
console.log('图标已更新到 icons/');
