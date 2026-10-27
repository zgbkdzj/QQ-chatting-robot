// 多群记忆共享（Memory Sharing Groups）
//
// 需求（owner，2026-10-10）：控制台里自由选择哪些群/私聊的记忆共享、哪些独立；
// 且三类记忆（进行中的话题 / 想说但还没说的 / 对群友的印象）**可分别控制**。
//
// ── 设计：读时合并（read-time merge），写入仍归本会话 ────────────────────────
// 为什么不做"写时复制到组内所有会话"：
//   ① 改分组时要回溯历史数据，麻烦且易漏；
//   ② 多个会话同时写同一份共享数据，容易互相覆盖（并发写冲突）；
//   ③ 退出组时要"把共享内容摘出去"，无法干净分离（分不清哪条是自己写的）。
// 读时合并天然规避这三点：数据只存一份（各自的会话），分组配置变了立即生效。
//
// ── 数据模型 ────────────────────────────────────────────────────────────────
// state/memory-groups.json:
// {
//   "groups": [
//     {
//       "id": "g1",
//       "name": "铁路群",
//       "members": ["group:<groupA>", "group:<groupC>"],
//       "share": { "activeTopic": true, "pendingThought": false, "memberImpression": true }
//     }
//   ]
// }
//
// 语义：
//   - 一个会话可同时属于多个组（并集合并）
//   - 不在任何组的会话 = 完全独立（保持原有行为）
//   - share 里某类为 false = 该类不跨群（即使在同一组里也只看自己的）
import fs from 'node:fs';
import path from 'node:path';

export const SHARE_CATEGORIES = ['activeTopic', 'pendingThought', 'memberImpression'];

/** 记忆类别 -> 会话状态里的字段名 */
const CATEGORY_FIELD = {
  activeTopic: 'activeTopics',
  pendingThought: 'pendingThoughts',
  memberImpression: 'memberImpressions',
};

export function emptyGroups() {
  return { groups: [] };
}

/** 归一化一个组：补 id/name/members/share，过滤非法成员。 */
export function normalizeGroup(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? fallbackId ?? '').trim();
  if (!id) return null;
  const name = String(raw.name ?? '').trim().slice(0, 60) || id;
  const members = Array.isArray(raw.members)
    ? [...new Set(raw.members.map((m) => String(m ?? '').trim()).filter((m) => /^(group|private):\d+$/.test(m)))]
    : [];
  const share = {};
  for (const c of SHARE_CATEGORIES) {
    // 缺省：话题与印象默认共享，想法默认不共享（想法通常是针对具体会话的）
    const dflt = c !== 'pendingThought';
    share[c] = raw.share && typeof raw.share === 'object' && c in raw.share
      ? raw.share[c] === true
      : dflt;
  }
  return { id, name, members, share };
}

/** 归一化整份配置（去重 id、清理非法项）。 */
export function normalizeGroups(raw) {
  const list = Array.isArray(raw?.groups) ? raw.groups : [];
  const seen = new Set();
  const groups = [];
  let i = 0;
  for (const g of list) {
    i++;
    const n = normalizeGroup(g, 'g' + i);
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    groups.push(n);
  }
  return { groups };
}

export function loadGroups(file) {
  try {
    if (!fs.existsSync(file)) return emptyGroups();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return normalizeGroups(raw);
  } catch {
    // 读坏时返回空（不影响主流程），由调用方决定是否告警
    return emptyGroups();
  }
}

export function saveGroups(file, data) {
  const norm = normalizeGroups(data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(norm, null, 2) + '\n', 'utf8');
  return norm;
}

/** 生成不冲突的组 id。 */
export function nextGroupId(groups) {
  const used = new Set((groups?.groups ?? []).map((g) => g.id));
  let n = 1;
  while (used.has('g' + n)) n++;
  return 'g' + n;
}

/**
 * 找出某会话所在的**所有**组（一个会话可在多个组里）。
 * 返回 { group, shares: { category: bool } }[]，即该会话在每个组里各类是否共享。
 */
export function groupsOf(groups, key) {
  const out = [];
  for (const g of groups?.groups ?? []) {
    if (g.members.includes(key)) out.push(g);
  }
  return out;
}

/**
 * 计算某会话在某类别下，应该"额外看到"哪些会话的记忆。
 *
 * 返回 sourceKeys 数组（不含自己）。判定规则：
 *   与该会话同属某组 **且** 该组该类 share=true 的成员，即为来源。
 *   多个组取并集。
 */
export function shareSourcesFor(groups, key, category) {
  if (!SHARE_CATEGORIES.includes(category)) return [];
  const sources = new Set();
  for (const g of groupsOf(groups, key)) {
    if (g.share?.[category] !== true) continue;
    for (const m of g.members) {
      if (m !== key) sources.add(m);
    }
  }
  return [...sources];
}

/**
 * 合并记忆：把自己 + 共享来源的该类数据合起来。
 *
 * @param {object} ownState   本会话状态（含 activeTopics/pendingThoughts/memberImpressions）
 * @param {Map}    allStates  key -> 会话状态
 * @param {object} groups     分组配置
 * @param {string} key        本会话 key
 * @returns {object} 合并后的伪状态（只含该类字段，供 formatMemoryV2 使用）
 *
 * 合并规则：
 *   - activeTopic / pendingThought：按 text 去重（同 text 保留 lastMentionAt 较新者），
 *     并按时间排序（新的在后，与 formatMemoryV2 的 slice(-10) 取最近一致）。
 *   - memberImpression：按人名合并，traits 取并集（去重），interactionCount 相加，
 *     lastSeenAt 取较新。
 */
export function mergeMemory(ownState, allStates, groups, key) {
  const merged = { activeTopics: [], pendingThoughts: [], memberImpressions: {} };
  if (!ownState) return merged;

  // ── 话题 ──
  const topicSources = [ownState, ...shareSourcesFor(groups, key, 'activeTopic').map((k) => allStates?.get?.(k)).filter(Boolean)];
  const topicMap = new Map();   // text -> topic
  for (const st of topicSources) {
    for (const t of (Array.isArray(st.activeTopics) ? st.activeTopics : [])) {
      if (!t || !t.text) continue;
      const prev = topicMap.get(t.text);
      if (!prev) { topicMap.set(t.text, { ...t }); continue; }
      // 同 text：保留更新的 lastMentionAt，参与者取并集，待追问取非空
      const newer = (Number(t.lastMentionAt) || 0) >= (Number(prev.lastMentionAt) || 0) ? t : prev;
      const parts = new Set([...(prev.participants || []), ...(t.participants || [])]);
      topicMap.set(t.text, {
        ...newer,
        participants: [...parts],
        pendingQuestion: t.pendingQuestion || prev.pendingQuestion || '',
      });
    }
  }
  merged.activeTopics = [...topicMap.values()]
    .sort((a, b) => (Number(a.lastMentionAt) || 0) - (Number(b.lastMentionAt) || 0));

  // ── 想法 ──
  const thoughtSources = [ownState, ...shareSourcesFor(groups, key, 'pendingThought').map((k) => allStates?.get?.(k)).filter(Boolean)];
  const thoughtMap = new Map();   // text -> thought
  for (const st of thoughtSources) {
    for (const t of (Array.isArray(st.pendingThoughts) ? st.pendingThoughts : [])) {
      if (!t || !t.text) continue;
      const prev = thoughtMap.get(t.text);
      if (!prev) { thoughtMap.set(t.text, { ...t }); continue; }
      // 取 expiresAt 较晚的（更"新鲜"），motivation 取非空
      const newer = (Number(t.expiresAt) || 0) >= (Number(prev.expiresAt) || 0) ? t : prev;
      thoughtMap.set(t.text, { ...newer, motivation: t.motivation || prev.motivation || '' });
    }
  }
  merged.pendingThoughts = [...thoughtMap.values()]
    .sort((a, b) => (Number(a.expiresAt) || 0) - (Number(b.expiresAt) || 0));

  // ── 印象 ──
  const impSources = [ownState, ...shareSourcesFor(groups, key, 'memberImpression').map((k) => allStates?.get?.(k)).filter(Boolean)];
  const impMap = new Map();   // name -> { traits:Set, interactionCount, lastSeenAt }
  for (const st of impSources) {
    const imps = (st.memberImpressions && typeof st.memberImpressions === 'object') ? st.memberImpressions : {};
    for (const [name, im] of Object.entries(imps)) {
      if (!name) continue;
      const cur = impMap.get(name) ?? { traits: new Set(), interactionCount: 0, lastSeenAt: 0 };
      for (const tr of (Array.isArray(im?.traits) ? im.traits : [])) {
        const s = String(tr ?? '').trim();
        if (s) cur.traits.add(s);
      }
      cur.interactionCount += Number(im?.interactionCount) || 0;
      cur.lastSeenAt = Math.max(cur.lastSeenAt, Number(im?.lastSeenAt) || 0);
      impMap.set(name, cur);
    }
  }
  const outImps = {};
  for (const [name, v] of impMap) {
    outImps[name] = {
      traits: [...v.traits],
      interactionCount: v.interactionCount,
      lastSeenAt: v.lastSeenAt,
    };
  }
  merged.memberImpressions = outImps;

  return merged;
}

/**
 * 便捷：判断某会话是否有任何共享关系（用于 UI 显示"共享中"标记）。
 */
export function hasAnySharing(groups, key) {
  return groupsOf(groups, key).some((g) => SHARE_CATEGORIES.some((c) => g.share?.[c] === true));
}

/** 某会话在各组里的共享摘要（供 UI/API 展示）。 */
export function sharingSummary(groups, key) {
  return groupsOf(groups, key).map((g) => ({
    id: g.id,
    name: g.name,
    share: { ...g.share },
    memberCount: g.members.length,
  }));
}

export { CATEGORY_FIELD };
