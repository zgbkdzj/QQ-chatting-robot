#!/usr/bin/env node
/**
 * 表情包批量导入 + 全自动备注工具
 *
 * 用法：
 *   node sticker-import.js <图片文件夹> [--dry-run] [--no-remark] [--limit N]
 *
 * 做什么：
 *   1. 扫描文件夹里的图片（png/jpg/gif/webp）
 *   2. 逐张通过桥接收藏进 QQ（走 /api/socialV2/collect-sticker 的底层 add_custom_face）
 *      —— QQ 侧没有批量接口，只能逐张；超 4MB 会自动抽帧（GIF）
 *   3. 对收藏后没有备注的表情，自动看图让模型生成简短备注，
 *      同时写入 QQ 官方备注(desc) 和本地 json(localNote/tags)
 *
 * 关键：QQ 官方备注走 modify_custom_face，本地库走 /api/socialV2/sticker-note。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 用 fileURLToPath 正确解码 URL 编码（路径含空格/%20 时不会出错）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE_TOKEN = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
const BASE = 'http://127.0.0.1:3100';
const STICKER_FILE = path.join(ROOT, 'state', 'stickers.json');

const IMG_EXT = /\.(png|jpe?g|gif|webp)$/i;
const MAX_BYTES = 4_000_000; // 与桥接一致：add_custom_face 实测 4MB 硬上限

// ── 参数 ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const DRY = args.includes('--dry-run');
const NO_REMARK = args.includes('--no-remark');
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) || 0 : 0;

if (!dir) {
  console.error('用法: node sticker-import.js <图片文件夹> [--dry-run] [--no-remark] [--limit N]');
  process.exit(1);
}
if (!fs.existsSync(dir)) { console.error('文件夹不存在:', dir); process.exit(1); }

async function api(p, method = 'GET', body) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-console-token': CONSOLE_TOKEN },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

// ── 1. 扫描图片 ────────────────────────────────────────────────────────────
function scanImages(d) {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...scanImages(p));
    else if (IMG_EXT.test(e.name)) out.push(p);
  }
  return out.sort();
}

let files = scanImages(dir);
if (LIMIT) files = files.slice(0, LIMIT);
console.log(`扫描到 ${files.length} 张图片${DRY ? '（dry-run 模式，不会真的收藏）' : ''}`);

// ── 2. 读本地库（用于判断哪些已有备注）────────────────────────────────────
function loadStore() {
  try {
    let t = fs.readFileSync(STICKER_FILE, 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return JSON.parse(t);
  } catch { return []; }
}

// ── 3. 逐张收藏 ────────────────────────────────────────────────────────────
// 桥接的 collect-sticker 只接受会话里的 messageId，导入需要用底层能力。
// 这里直接用桥接已实现的字节通道：通过 console 的 sticker-add 端点（见下方新增）。
const added = [];
const failed = [];

for (const [i, file] of files.entries()) {
  const buf = fs.readFileSync(file);
  let payload = buf;
  if (buf.length > MAX_BYTES) {
    const { shrinkGifToLimit } = await import('./gif-shrink.js');
    const s = shrinkGifToLimit(buf, MAX_BYTES);
    if (s && s.buffer.length <= MAX_BYTES) {
      payload = s.buffer;
      console.log(`  [${i + 1}/${files.length}] ${path.basename(file)} 超 ${Math.round(buf.length / 1024)}KB，抽帧至 ${Math.round(payload.length / 1024)}KB`);
    } else {
      failed.push({ file, why: `超 ${MAX_BYTES / 1024 / 1024}MB 无法压缩` });
      continue;
    }
  }
  if (DRY) { added.push({ file, emojiId: '(dry)' }); continue; }

  const r = await api('/api/socialV2/sticker-add', 'POST', {
    file: 'base64://' + payload.toString('base64'),
    remark: '' // 备注由后面的自动备注流程统一生成
  });
  if (r.json.ok) {
    added.push({ file, emojiId: r.json.emojiId ?? r.json.sticker?.md5 });
    console.log(`  [${i + 1}/${files.length}] ✅ ${path.basename(file)} -> ${r.json.emojiId ?? ''}`);
  } else {
    failed.push({ file, why: r.json.error ?? `HTTP ${r.status}` });
    console.log(`  [${i + 1}/${files.length}] ❌ ${path.basename(file)}: ${r.json.error ?? r.status}`);
  }
  await new Promise((r2) => setTimeout(r2, 350)); // 轻微限速，避免打爆网关
}

console.log(`\n收藏完成：成功 ${added.length}，失败 ${failed.length}`);
if (failed.length) for (const f of failed.slice(0, 10)) console.log(`  失败: ${path.basename(f.file)} — ${f.why}`);

// ── 4. 自动备注（看图 → 生成 → 写 QQ desc + 本地 localNote/tags）─────────
if (NO_REMARK) { console.log('\n--no-remark：跳过自动备注'); process.exit(0); }

console.log('\n开始自动备注（无备注的表情才会处理）…');
const store = loadStore();
const needRemark = store.filter((e) => !String(e.desc ?? '').trim());
console.log(`本地库 ${store.length} 条，其中无备注 ${needRemark.length} 条`);

let ok = 0, skip = 0, err = 0;
for (const [i, e] of needRemark.entries()) {
  const id = e.md5 || e.id;
  const r = await api('/api/socialV2/sticker-auto-remark', 'POST', { stickerId: id });
  if (r.json.ok) {
    ok++;
    console.log(`  [${i + 1}/${needRemark.length}] ✅ ${id.slice(0, 12)}… -> ${r.json.remark ?? ''}`);
  } else {
    err++;
    console.log(`  [${i + 1}/${needRemark.length}] ❌ ${id.slice(0, 12)}…: ${r.json.error ?? r.status}`);
  }
  await new Promise((r2) => setTimeout(r2, 500));
  void skip;
}
console.log(`\n备注完成：成功 ${ok}，失败 ${err}`);
process.exit(0);
