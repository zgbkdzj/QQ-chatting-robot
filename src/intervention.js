// 管理员临时介入（Intervention）—— 控制台侧的后台干预，QQ 端完全无感。
//
// 需求（owner，2026-10-10）：
//   机器人正在和别人私聊时，管理员想在不打断会话的前提下临时改变它的输出行为，
//   比如「之后都用语音回话」「不要再回这个人」。QQ 端无感，只在后台改。
//
// ── 两类介入，生效机制不同 ────────────────────────────────────────────────────
//   1. directive（临时指令）：追加一段文字到该会话的唤醒提示词。
//      生效时机 = 下一次唤醒（prompt 在回合开始时就投递出去了，改不了已发出的）。
//   2. mute（静默拦截）：AI 照常思考，但回复不发出（QQ 端表现为"已读不回"）。
//      生效时机 = 立即（拦截发生在发送那一刻的实时判断）。
//
// ── 全部临时 ──────────────────────────────────────────────────────────────────
// owner 明确要求：介入必须都是临时的；永久性配置去「各群配置」改。
// 所以每条介入都**必须带过期条件**（时间 + 次数），到期自动失效，不留残留。
//
// 数据模型 state/intervention.json:
// {
//   "private:<peerQQ>": {
//     "directive": { "text": "之后都用语音回话", "expiresAt": 1791700000000, "remaining": 5, "createdAt": ..., "createdBy": "console" },
//     "mute":      { "expiresAt": 1791700000000, "remaining": 10, "createdAt": ..., "reason": "别理他" }
//   }
// }
import fs from 'node:fs';
import path from 'node:path';

/** 介入类型 */
/**
 * 介入类型。**只保留 directive** —— owner 要求删掉静默拦截，
 * 把"不回复"统一到黑名单（见 blacklist.js）：黑名单支持按人、整个会话、群与私聊，粒度更全。
 * 历史上曾有 'mute'（整会话静默），已移除。
 */
export const INTERVENTION_KINDS = ['directive'];

/** 默认过期时长（分钟）——不指定时用，避免忘记关导致永久生效 */
export const DEFAULT_TTL_MINUTES = 30;
/** 单条指令最大字数 */
export const MAX_DIRECTIVE_CHARS = 500;

/** 空状态 */
export function emptyState() {
  return { byKey: {} };
}

/** 归一化一条介入记录（含过期判定）。返回 null 表示已失效/非法。 */
export function normalizeEntry(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const expiresAt = Number(raw.expiresAt) || 0;
  const remaining = raw.remaining === undefined || raw.remaining === null ? null : Number(raw.remaining);
  // 已过期（时间为 0 表示"不过期"，但本功能要求必须有时限，所以 0 视为立即失效）
  if (!expiresAt || expiresAt <= now) return null;
  if (remaining !== null && (!Number.isFinite(remaining) || remaining <= 0)) return null;
  return {
    expiresAt,
    remaining: remaining === null ? null : Math.floor(remaining),
    createdAt: Number(raw.createdAt) || now,
    createdBy: String(raw.createdBy ?? 'console').slice(0, 40),
    ...(raw.text !== undefined ? { text: String(raw.text).slice(0, MAX_DIRECTIVE_CHARS) } : {}),
    ...(raw.reason !== undefined ? { reason: String(raw.reason).slice(0, 200) } : {}),
  };
}

/** 归一化整份状态（清理所有已失效项）。 */
export function normalizeState(raw, now = Date.now()) {
  const out = { byKey: {} };
  const src = raw?.byKey && typeof raw.byKey === 'object' ? raw.byKey : {};
  for (const [key, v] of Object.entries(src)) {
    if (!/^(group|private):\d+$/.test(key)) continue;
    const clean = {};
    for (const kind of INTERVENTION_KINDS) {
      const e = normalizeEntry(v?.[kind], now);
      if (e) clean[kind] = e;
    }
    if (Object.keys(clean).length) out.byKey[key] = clean;
  }
  return out;
}

export function loadState(file, now = Date.now()) {
  try {
    if (!fs.existsSync(file)) return emptyState();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return normalizeState(raw, now);
  } catch {
    return emptyState();
  }
}

export function saveState(file, data, now = Date.now()) {
  const norm = normalizeState(data, now);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(norm, null, 2) + '\n', 'utf8');
  return norm;
}

/**
 * 设置一条介入。
 * @param {object} data  当前状态
 * @param {string} key   会话 key
 * @param {string} kind  'directive' | 'mute'
 * @param {object} opts  { text?, reason?, ttlMinutes?, maxUses? }
 */
export function setIntervention(data, key, kind, opts = {}, now = Date.now()) {
  if (!INTERVENTION_KINDS.includes(kind)) throw new Error('未知介入类型：' + kind);
  if (!/^(group|private):\d+$/.test(key)) throw new Error('key 格式应为 group:群号 或 private:QQ号');

  const ttlMin = Number(opts.ttlMinutes) > 0 ? Number(opts.ttlMinutes) : DEFAULT_TTL_MINUTES;
  const maxUses = opts.maxUses === undefined || opts.maxUses === null || opts.maxUses === ''
    ? null
    : Math.max(1, Math.floor(Number(opts.maxUses)));

  const entry = {
    expiresAt: now + ttlMin * 60000,
    remaining: maxUses,
    createdAt: now,
    createdBy: String(opts.createdBy ?? 'console').slice(0, 40),
  };

  if (kind === 'directive') {
    const text = String(opts.text ?? '').trim();
    if (!text) throw new Error('临时指令内容不能为空');
    entry.text = text.slice(0, MAX_DIRECTIVE_CHARS);
  } else {
    entry.reason = String(opts.reason ?? '').slice(0, 200);
  }

  const next = normalizeState(data, now);
  next.byKey[key] = { ...(next.byKey[key] ?? {}), [kind]: entry };
  return next;
}

/** 清除某会话的某类介入（kind 省略 = 全清）。 */
export function clearIntervention(data, key, kind = null, now = Date.now()) {
  const next = normalizeState(data, now);
  if (!next.byKey[key]) return next;
  if (!kind) { delete next.byKey[key]; return next; }
  delete next.byKey[key][kind];
  if (!Object.keys(next.byKey[key]).length) delete next.byKey[key];
  return next;
}

/** 取某会话当前生效的介入（已自动过滤过期项）。 */
export function getIntervention(data, key, now = Date.now()) {
  const e = data?.byKey?.[key];
  if (!e) return {};
  const out = {};
  for (const kind of INTERVENTION_KINDS) {
    const n = normalizeEntry(e[kind], now);
    if (n) out[kind] = n;
  }
  return out;
}

/** 该会话当前是否被静默拦截。 */
export function isMuted(data, key, now = Date.now()) {
  return !!normalizeEntry(data?.byKey?.[key]?.mute, now);
}

/** 取该会话的临时指令文本（无则空串）。 */
export function directiveFor(data, key, now = Date.now()) {
  const n = normalizeEntry(data?.byKey?.[key]?.directive, now);
  return n?.text ? String(n.text) : '';
}

/**
 * 消费一次"次数额度"（mute 拦截成功 / directive 被投递时调用）。
 * 返回新状态。remaining 为 null（不限次）时只检查时间过期。
 */
export function consumeUse(data, key, kind, now = Date.now()) {
  const next = normalizeState(data, now);
  const e = next.byKey?.[key]?.[kind];
  if (!e) return next;
  if (e.remaining === null) return next;   // 不限次，只受时间约束
  e.remaining -= 1;
  if (e.remaining <= 0) {
    delete next.byKey[key][kind];
    if (!Object.keys(next.byKey[key]).length) delete next.byKey[key];
  }
  return next;
}

/** 人类可读摘要（供 UI/API 展示）。 */
export function describeEntry(entry, now = Date.now()) {
  if (!entry) return null;
  const mins = Math.max(0, Math.round((Number(entry.expiresAt) - now) / 60000));
  return {
    expiresAt: entry.expiresAt,
    expiresInMinutes: mins,
    remaining: entry.remaining,
    createdAt: entry.createdAt,
    createdBy: entry.createdBy,
    text: entry.text,
    reason: entry.reason,
  };
}
