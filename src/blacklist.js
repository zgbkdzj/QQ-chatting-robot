// 群成员黑名单（Per-group member blacklist）
//
// 需求（owner，2026-10-11）：在「各群配置」里新增「群黑名单」——
// 拉黑群里**具体的某个人**，以后他在群里说的话一概不回（其他人照常）。
//
// ── 与其它"静默"机制的区别（容易混淆，务必分清）──────────────────────────────
//   · 全局 silent 模式（/silent）：整个机器人对所有群友都不回，仅管理员可对话。
//   · 临时静默拦截（intervention.mute）：针对**整个会话**，AI 照常思考但回复不发，带过期。
//   · 群成员黑名单（本模块）：针对**群里具体的人**，他的消息直接不进未读队列
//     （连上下文都不占），其他人完全不受影响。
//
// ── 两种黑名单条目 ──────────────────────────────────────────────────────────
//   permanent: true  —— 永久（写在这里，owner 在「各群配置」显式增删）
//   permanent: false —— 临时（带 expiresAt，到期自动失效；供快速处置用）
//
// 数据模型 state/blacklist.json:
// {
//   "group:<groupA>": {
//     "1234567": { "permanent": true, "addedAt": 1791700000000, "note": "老是刷屏" },
//     "7654321": { "permanent": false, "expiresAt": 1791703600000, "addedAt": ..., "note": "禁言一小时" }
//   }
// }
//
// ⚠️ 管理员（ownerQQ）永远不被拉黑：否则 owner 会把自己锁在门外，无法自救。
import fs from 'node:fs';
import path from 'node:path';

/** 备注最大长度 */
export const MAX_NOTE_CHARS = 60;

/** 归一化单条黑名单记录。返回 null = 已失效/非法。 */
export function normalizeEntry(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const permanent = raw.permanent === true;
  if (permanent) {
    return {
      permanent: true,
      addedAt: Number(raw.addedAt) || now,
      note: String(raw.note ?? '').slice(0, MAX_NOTE_CHARS),
    };
  }
  const expiresAt = Number(raw.expiresAt) || 0;
  if (!expiresAt || expiresAt <= now) return null;   // 临时条目必须有时限且未过期
  return {
    permanent: false,
    expiresAt,
    addedAt: Number(raw.addedAt) || now,
    note: String(raw.note ?? '').slice(0, MAX_NOTE_CHARS),
  };
}

/** 「整个会话」的哨兵 userId —— 表示拉黑该群/私聊里的**所有人**。 */
export const WHOLE_CONV = '__all__';

/** 合法的会话 key：群或私聊（owner 要求私聊也要能拉黑）。 */
export function isValidConvKey(k) {
  return /^(group|private):\d+$/.test(String(k ?? ''));
}

/** 归一化整份黑名单（清理过期项、过滤非法 key）。 */
export function normalizeState(raw, now = Date.now()) {
  const out = {};
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  for (const [convKey, members] of Object.entries(src)) {
    // 群与私聊都支持（私聊拉黑 = 不再理会该好友）
    if (!isValidConvKey(convKey)) continue;
    if (!members || typeof members !== 'object' || Array.isArray(members)) continue;
    const clean = {};
    for (const [uid, entry] of Object.entries(members)) {
      // 允许哨兵 WHOLE_CONV（整个会话），其余必须是纯数字 QQ 号
      if (uid !== WHOLE_CONV && !/^\d+$/.test(uid)) continue;
      const n = normalizeEntry(entry, now);
      if (n) clean[uid] = n;
    }
    if (Object.keys(clean).length) out[convKey] = clean;
  }
  return out;
}

export function loadState(file, now = Date.now()) {
  try {
    if (!fs.existsSync(file)) return {};
    return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')), now);
  } catch {
    return {};
  }
}

export function saveState(file, data, now = Date.now()) {
  const norm = normalizeState(data, now);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(norm, null, 2) + '\n', 'utf8');
  return norm;
}

/**
 * 添加黑名单条目。
 * @param {object} data 当前状态
 * @param {string} convKey 'group:群号' 或 'private:QQ号'
 * @param {string} userId  被拉黑的 QQ 号；传 WHOLE_CONV 表示拉黑整个会话
 * @param {object} opts { permanent?: boolean, ttlMinutes?: number, note?: string, ownerQQ?: string }
 */
export function addEntry(data, convKey, userId, opts = {}, now = Date.now()) {
  if (!isValidConvKey(convKey)) throw new Error('key 格式应为 group:群号 或 private:QQ号');
  const uid = String(userId ?? '').trim();
  // 允许哨兵（整个会话），其余必须是纯数字 QQ 号
  if (uid !== WHOLE_CONV && !/^\d+$/.test(uid)) throw new Error('QQ 号必须是纯数字（或用「整个会话」选项）');
  // 管理员豁免：拉黑 owner 会把自己锁在门外
  if (uid !== WHOLE_CONV && opts.ownerQQ && uid === String(opts.ownerQQ)) {
    throw new Error('不能拉黑管理员（ownerQQ）——那会让你自己也收不到机器人的回复');
  }
  // 私聊里"整个会话"= 拉黑对方本人（语义等价，但保留哨兵写法便于统一处理）

  const permanent = opts.permanent !== false;   // 默认永久（owner 在配置页显式增删）
  const entry = {
    permanent,
    addedAt: now,
    note: String(opts.note ?? '').slice(0, MAX_NOTE_CHARS),
  };
  if (!permanent) {
    const ttl = Number(opts.ttlMinutes) > 0 ? Number(opts.ttlMinutes) : 60;
    entry.expiresAt = now + ttl * 60000;
  }

  const next = normalizeState(data, now);
  next[convKey] = { ...(next[convKey] ?? {}), [uid]: entry };
  return next;
}

/** 移除黑名单条目。 */
export function removeEntry(data, convKey, userId, now = Date.now()) {
  const next = normalizeState(data, now);
  if (!next[convKey]) return next;
  delete next[convKey][String(userId ?? '').trim()];
  if (!Object.keys(next[convKey]).length) delete next[convKey];
  return next;
}

/** 清空某群的黑名单（保留其它群）。 */
export function clearGroup(data, convKey, now = Date.now()) {
  const next = normalizeState(data, now);
  delete next[convKey];
  return next;
}

/**
 * 判断某人是否被拉黑（含"整个会话"哨兵）。
 *
 * 三种命中情况：
 *   ① 该会话被整体拉黑（WHOLE_CONV）—— 群里所有人都被拦
 *   ② 该 userId 被单独拉黑
 *   ③ 私聊会话：对方的 QQ 号与 key 里的 QQ 号一致，整体拉黑同样命中
 *
 * @returns {boolean}
 */
export function isBlocked(data, convKey, userId, now = Date.now()) {
  if (!convKey) return false;
  const members = data?.[convKey];
  if (!members) return false;
  // ① 整个会话被拉黑
  if (normalizeEntry(members[WHOLE_CONV], now)) return true;
  // ② 具体某个人被拉黑
  if (!userId) return false;
  return !!normalizeEntry(members[String(userId)], now);
}

/** 该会话是否被整体拉黑。 */
export function isWholeConvBlocked(data, convKey, now = Date.now()) {
  return !!normalizeEntry(data?.[convKey]?.[WHOLE_CONV], now);
}

/** 取某会话的黑名单（含人类可读的剩余时间）。 */
export function listGroup(data, convKey, now = Date.now()) {
  const members = data?.[convKey] ?? {};
  const out = [];
  for (const [uid, raw] of Object.entries(members)) {
    const e = normalizeEntry(raw, now);
    if (!e) continue;
    out.push({
      userId: uid,
      // 哨兵项：UI 显示为「整个会话」而不是一串 __all__
      wholeConv: uid === WHOLE_CONV,
      label: uid === WHOLE_CONV ? '整个会话' : uid,
      permanent: e.permanent,
      note: e.note,
      addedAt: e.addedAt,
      expiresAt: e.expiresAt ?? null,
      expiresInMinutes: e.permanent ? null : Math.max(0, Math.round((e.expiresAt - now) / 60000)),
    });
  }
  // 整体拉黑排最前（影响面最大），其余按添加时间倒序
  out.sort((a, b) => Number(b.wholeConv) - Number(a.wholeConv)
    || Number(b.permanent) - Number(a.permanent)
    || b.addedAt - a.addedAt);
  return out;
}

/** 汇总所有群的黑名单（供控制台总览）。 */
export function listAll(data, now = Date.now()) {
  const out = {};
  for (const convKey of Object.keys(data ?? {})) {
    const l = listGroup(data, convKey, now);
    if (l.length) out[convKey] = l;
  }
  return out;
}
