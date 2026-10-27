// 本地 GPT-SoVITS 语音合成：文本 -> wav 文件
// 桥接不内嵌 TTS 模型，调用本机常驻服务 http://127.0.0.1:9880
// 音色：whale2（鲸鱼娘），权重由 SoVITS 服务端 tts_infer.yaml 的 custom 段决定。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TTS_DEFAULTS = {
  enabled: false,
  apiUrl: 'http://127.0.0.1:9880/tts',
  refAudio: 'audio/ref/ref.wav',
  refText: '你们鄙人只能吃一碗吗？没有多的了，用户回来发现会骂我大肥鱼。',
  refLang: 'zh',
  textLang: 'zh',
  // 「王牌组合」（12 组自然度对比里的当前最优候选）
  params: {
    temperature: 1.3,
    top_k: 25,
    top_p: 0.95,
    speed_factor: 1.1,
    fragment_interval: 0.1,
    text_split_method: 'cut5',
    repetition_penalty: 1.35,
  },
  outDir: 'audio/tts',
  timeoutMs: 120000,
  maxChars: 200,
  // 合成产物保留策略（每次合成后清理一次，见 pruneTtsDir）
  keepHours: 24,
  keepCount: 50,
};

export function resolveTtsPath(base, p) {
  const s = String(p ?? '').trim();
  if (!s) return '';
  return path.isAbsolute(s) ? s : path.resolve(base, s);
}

export async function probeTts(apiUrl, timeoutMs = 4000) {
  const root = String(apiUrl || '').replace(/\/tts\/?$/, '') || 'http://127.0.0.1:9880';
  try {
    const r = await fetch(root + '/', { signal: AbortSignal.timeout(timeoutMs) });
    return { online: true, status: r.status };
  } catch (error) {
    const msg = String(error?.message ?? error);
    if (/4\d\d|5\d\d/.test(msg)) return { online: true, status: Number((msg.match(/(\d{3})/) || [])[1]) };
    return { online: false, error: msg };
  }
}

export async function synthSpeech(o) {
  const text = String(o.text ?? '').trim();
  if (!text) return { ok: false, error: 'text empty' };
  if (!o.refAudio) return { ok: false, error: 'missing refAudio' };
  if (!fs.existsSync(o.refAudio)) return { ok: false, error: 'refAudio not found: ' + o.refAudio };
  const t0 = Date.now();
  try {
    fs.mkdirSync(path.dirname(o.outPath), { recursive: true });
    const payload = {
      text,
      text_lang: o.textLang || 'zh',
      ref_audio_path: o.refAudio,
      prompt_text: String(o.refText ?? ''),
      prompt_lang: o.refLang || 'zh',
      media_type: 'wav',
      streaming_mode: false,
      ...(o.params || {}),
    };
    const r = await fetch(o.apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(o.timeoutMs || 120000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { ok: false, error: 'TTS HTTP ' + r.status + ': ' + String(body).slice(0, 200), ms: Date.now() - t0 };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return { ok: false, error: 'TTS empty audio', ms: Date.now() - t0 };
    fs.writeFileSync(o.outPath, buf);
    return { ok: true, outPath: o.outPath, bytes: buf.length, ms: Date.now() - t0 };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), ms: Date.now() - t0 };
  }
}

// ── 合成产物清理 ───────────────────────────────────────────────────────────────
// 每次说话都在 audio/tts/ 落一个 ~370KB 的 wav，跑几天就能堆出几百 MB；
// 而且这些文件会和 owner 手动放进语音库的音频一起出现在 qq_list_voices 里，
// 让 AI 有机会误发一段过期的旧话（内容早就和当前对话无关了）。
// 所以每次合成后顺手清理一次：按「保留时长」+「保留个数」双阈值裁掉最旧的。
export const TTS_PRUNE_DEFAULTS = {
  keepHours: 24,
  keepCount: 50,
};

/**
 * 清理合成输出目录里的旧 tts-*.wav。
 *
 * 只动自己生成的文件（严格匹配 `tts-<16位hex>.wav`），绝不删 owner 放进语音库的音频。
 * keepFiles 里的文件名（如刚生成的那个）无条件保留。
 * 返回 { removed, kept, bytes } 供日志记录；任何异常都吞掉（清理失败不该影响说话）。
 */
export function pruneTtsDir(dir, { keepHours = 24, keepCount = 50, keepFiles = [] } = {}) {
  const result = { removed: 0, kept: 0, bytes: 0 };
  try {
    if (!fs.existsSync(dir)) return result;
    const protect = new Set(keepFiles.map((f) => String(f)));
    const entries = [];
    for (const name of fs.readdirSync(dir)) {
      if (!/^tts-[0-9a-f]{16}\.wav$/i.test(name)) continue; // 只认自己生成的
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      entries.push({ name, full, mtimeMs: st.mtimeMs, size: st.size });
    }
    // 新的在前
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const cutoff = Date.now() - Math.max(1, Number(keepHours) || 24) * 3600000;
    const limit = Math.max(1, Number(keepCount) || 50);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (protect.has(e.name)) { result.kept++; continue; }
      const tooOld = e.mtimeMs < cutoff;
      const tooMany = i >= limit;
      if (!tooOld && !tooMany) { result.kept++; continue; }
      try {
        fs.unlinkSync(e.full);
        result.removed++;
        result.bytes += e.size;
      } catch { result.kept++; }
    }
  } catch { /* 清理是尽力而为，绝不向外抛 */ }
  return result;
}

export function ttsOutName(text, extra) {
  const h = crypto.createHash('sha1').update(String(text) + '|' + String(extra || '')).digest('hex').slice(0, 16);
  return 'tts-' + h + '.wav';
}
