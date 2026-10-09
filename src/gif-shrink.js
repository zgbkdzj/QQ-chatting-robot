/**
 * GIF 抽帧降体积（纯 Node 实现，无外部依赖）。
 *
 * 背景：QQ/SnowLuma 的 add_custom_face 对收藏文件有约 4MB 的硬上限，超了会
 * "fetch failed"。大幅动图（如 4.7MB）无法直接收藏。这里通过丢弃部分帧来降低
 * 体积：GIF 是逐帧存储，抽掉一半帧通常能把体积降到 50% 左右，仍保留动图效果。
 *
 * 只做「丢弃整帧」这一件事，不重新编码像素，因此不损失画质、不需要图像库。
 * 每个被保留的帧都连同它前面的 Graphic Control Extension（含帧延迟）一起保留，
 * 保证动画时序正确。
 */

const HEADER = 6; // "GIF89a"
const TRAILER = 0x3b;
const EXT_INTRO = 0x21;
const IMAGE_DESC = 0x2c;
const GCE_LABEL = 0xf9; // Graphic Control Extension

/** 读取 GIF 全局颜色表之后的块流，返回帧列表与其余块。 */
function parseBlocks(buf, start) {
  const blocks = [];
  let p = start;
  while (p < buf.length) {
    const b = buf[p];
    if (b === TRAILER) break;
    if (b === EXT_INTRO) {
      const label = buf[p + 1];
      let q = p + 2;
      // 扩展块内是一系列 sub-block：长度字节 + 数据，以 0x00 结束
      while (q < buf.length) {
        const len = buf[q];
        if (len === 0) { q += 1; break; }
        q += 1 + len;
      }
      blocks.push({ type: 'ext', label, start: p, end: q, isGCE: label === GCE_LABEL });
      p = q;
    } else if (b === IMAGE_DESC) {
      // 图像描述符 10 字节，其后是可选局部颜色表 + LZW 最小码长 + 数据 sub-blocks
      let q = p + 10;
      const packed = buf[p + 9];
      if (packed & 0x80) q += 3 * (2 ** ((packed & 0x07) + 1)); // 局部颜色表
      q += 1; // LZW minimum code size
      while (q < buf.length) {
        const len = buf[q];
        if (len === 0) { q += 1; break; }
        q += 1 + len;
      }
      blocks.push({ type: 'image', start: p, end: q });
      p = q;
    } else {
      // 未知块（损坏或非标准），停止安全解析
      break;
    }
  }
  return { blocks, end: p };
}

/**
 * 抽帧：保留一部分帧，丢弃其余。
 * @param {Buffer} buf 原始 GIF 字节
 * @param {number} keepRatio 保留比例（0~1），如 0.5 表示保留一半帧
 * @returns {Buffer|null} 抽帧后的 GIF；无法解析或无需抽帧时返回 null
 */
export function shrinkGifByDroppingFrames(buf, keepRatio = 0.5) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER + 7 + 1) return null;
  const sig = buf.toString('ascii', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;

  // 逻辑屏幕描述符 7 字节，其后可能有全局颜色表
  let p = HEADER + 7;
  const packed = buf[HEADER + 4];
  if (packed & 0x80) p += 3 * (2 ** ((packed & 0x07) + 1));

  const { blocks } = parseBlocks(buf, p);
  const frames = blocks.filter((b) => b.type === 'image');
  if (frames.length <= 1) return null; // 单帧无法抽

  const keepEvery = Math.max(2, Math.round(1 / Math.min(1, Math.max(0.05, keepRatio))));
  const parts = [buf.slice(0, p)]; // header + screen descriptor + GCT
  let imgIndex = 0;
  let kept = 0;
  let pendingGCE = null;
  for (const b of blocks) {
    if (b.type === 'ext') {
      if (b.isGCE) pendingGCE = b; // 先攒着，决定是否随下一帧保留
      else parts.push(buf.slice(b.start, b.end)); // 其它扩展（如循环控制）必须保留
      continue;
    }
    // 图像帧
    const keep = imgIndex % keepEvery === 0;
    if (keep) {
      if (pendingGCE) parts.push(buf.slice(pendingGCE.start, pendingGCE.end));
      parts.push(buf.slice(b.start, b.end));
      kept += 1;
    }
    pendingGCE = null;
    imgIndex += 1;
  }
  if (kept === 0 || kept === frames.length) return null; // 没抽掉任何帧，无意义
  parts.push(Buffer.from([TRAILER]));
  return Buffer.concat(parts);
}

/**
 * 逐步加大抽帧力度，直到体积降到 maxBytes 以下。
 * @returns {{ buffer: Buffer, framesKeptRatio: number, originalBytes: number }|null}
 */
export function shrinkGifToLimit(buf, maxBytes) {
  if (!Buffer.isBuffer(buf) || buf.length <= maxBytes) return null;
  const originalBytes = buf.length;
  // 从保留 90% 逐步降到保留 10%
  for (const ratio of [0.9, 0.75, 0.6, 0.5, 0.4, 0.33, 0.25, 0.2, 0.15, 0.1]) {
    const out = shrinkGifByDroppingFrames(buf, ratio);
    if (!out) continue;
    if (out.length <= maxBytes) {
      return { buffer: out, framesKeptRatio: ratio, originalBytes };
    }
  }
  // 全部试过仍超限，返回最小（保留 10%）的那版，让调用方决定
  const last = shrinkGifByDroppingFrames(buf, 0.1);
  return last ? { buffer: last, framesKeptRatio: 0.1, originalBytes } : null;
}
