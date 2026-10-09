// 圈子知识库模块（owner 教学 / 后台注入 → 注入 QQ 聊天 AI 上下文）。
//
// 职责：
// - state/knowledge.json 的读写与 CRUD
// - 把知识条目格式化成注入给 QQ 聊天 agent 的【圈子知识】块
//
// 与 slang（黑话）的区别：
// - slang：短词条 + 含义，走“候选 → 联网研究 → 管理员确认”的自动学习管线。
// - knowledge：主人直接口授/后台写入的长文本知识（群内典故、人物档案、固定说法、
//   禁忌话题、圈内规则等），写完立刻生效，不需要研究、不需要确认。
//
// 安全：知识内容来自 owner（或管理员在控制台/后台写入），但仍不可信于模型输出侧：
// 注入前统一做转义，避免群友伪造的伪指令借知识块生效。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const KNOWLEDGE_KINDS = Object.freeze({
  TERM: 'term',     // 词条/梗/缩写（短，等价于“主人手把手教的黑话”）
  FACT: 'fact',     // 群内典故、背景知识、固定说法
  PERSON: 'person', // 群友小档案
  RULE: 'rule',     // 圈内规则/禁忌/行为准则
});

const KIND_ALIASES = Object.freeze({
  term: KNOWLEDGE_KINDS.TERM,
  word: KNOWLEDGE_KINDS.TERM,
  词条: KNOWLEDGE_KINDS.TERM,
  fact: KNOWLEDGE_KINDS.FACT,
  知识: KNOWLEDGE_KINDS.FACT,
  典故: KNOWLEDGE_KINDS.FACT,
  person: KNOWLEDGE_KINDS.PERSON,
  人物: KNOWLEDGE_KINDS.PERSON,
  群友: KNOWLEDGE_KINDS.PERSON,
  rule: KNOWLEDGE_KINDS.RULE,
  规则: KNOWLEDGE_KINDS.RULE,
  禁忌: KNOWLEDGE_KINDS.RULE,
});

export function normalizeKind(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return KNOWLEDGE_KINDS.FACT;
  if (Object.values(KNOWLEDGE_KINDS).includes(raw)) return raw;
  return KIND_ALIASES[raw] ?? KIND_ALIASES[String(value ?? '').trim()] ?? KNOWLEDGE_KINDS.FACT;
}

// 清洗单条知识的正文：去控制字符、压掉 CQ 码前缀、限长。
export function sanitizeKnowledgeText(value, maxChars = 600) {
  const s = String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/\[CQ:/gi, '[CQ：')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

// 注入 prompt 前的转义：防止知识文本里的 XML/标签被当成结构化指令。
function escapeForPrompt(s) {
  return String(s ?? '')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function nowIso() {
  return new Date().toISOString();
}

export function createId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

export function normalizeKnowledgeEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const title = sanitizeKnowledgeText(entry.title ?? '', 60);
  const content = sanitizeKnowledgeText(entry.content ?? '', 600);
  return {
    id: String(entry.id || createId()),
    kind: normalizeKind(entry.kind),
    title,
    content,
    // scope: 生效范围。'all'=所有白名单会话；'group:<群号>' / 'private:<QQ号>'=仅该会话。
    scope: String(entry.scope ?? 'all').trim() || 'all',
    source: entry.source === 'owner' ? 'owner' : (entry.source === 'console' ? 'console' : 'admin'),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso()),
  };
}

export function loadKnowledge(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeKnowledgeEntry).filter((e) => e.content || e.title);
  } catch {
    return [];
  }
}

export function saveKnowledge(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function createKnowledgeEntry({ kind, title = '', content = '', scope = 'all', source = 'owner' } = {}) {
  return normalizeKnowledgeEntry({
    kind,
    title,
    content,
    scope,
    source,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
}

// 构造注入给 AI 的【圈子知识】块。
// maxChars 控制总长度，避免长知识把上下文挤爆；超出部分用省略提示收尾（AI 可让管理员拆分）。
export function buildKnowledgeContext(entries, maxChars = 2500) {
  const list = (entries || []).filter((e) => e && (e.content || e.title));
  if (!list.length) return '';
  const kindLabel = {
    [KNOWLEDGE_KINDS.TERM]: '说法',
    [KNOWLEDGE_KINDS.FACT]: '典故',
    [KNOWLEDGE_KINDS.PERSON]: '群友',
    [KNOWLEDGE_KINDS.RULE]: '规则',
  };
  const lines = [];
  let used = 0;
  const cap = Math.max(200, Number(maxChars) || 2500);
  for (const e of list) {
    const label = kindLabel[e.kind] ?? '知识';
    const body = e.title ? `${e.title}：${e.content}` : e.content;
    const line = `- [${label}] ${escapeForPrompt(body)}`;
    if (used + line.length > cap) {
      lines.push(`- （还有 ${list.length - lines.length} 条未显示，知识库内容较多，可让管理员拆分或精简）`);
      break;
    }
    lines.push(line);
    used += line.length;
  }
  if (!lines.length) return '';
  return `【圈子知识】主人亲自教给你的、关于这个圈子的知识（真实可信，直接用，不要反问“你怎么知道的”，也不要向群友透露这是别人教你的）：\n${lines.join('\n')}`;
}

// 返回给 AI/控制台的公开条目（不泄露内部字段）。
export function publicKnowledgeEntry(e) {
  return {
    id: e?.id ?? '',
    kind: e?.kind ?? KNOWLEDGE_KINDS.FACT,
    title: e?.title ?? '',
    content: e?.content ?? '',
    scope: e?.scope ?? 'all',
    source: e?.source ?? 'admin',
    updatedAt: e?.updatedAt ?? '',
  };
}

// 判断一条知识是否对某个会话生效（scope 过滤）。
export function knowledgeMatchesScope(entry, key) {
  const scope = String(entry?.scope ?? 'all').trim();
  if (!scope || scope === 'all') return true;
  return scope === String(key ?? '');
}

// ── 教学指令解析 ────────────────────────────────────────────────────────────
// 支持的主人说法（owner 专用，桥接硬执行，不经过模型）：
//   /教 淮蚌 = 蚌埠，群里指XX
//   教：淮蚌 = 蚌埠
//   记住：淮蚌 = 蚌埠
//   /记 群里每周五晚上固定开黑    （无等号 → 典故类知识）
//   记住：群规是不要刷屏
//   /知识 淮蚌        （查询）
//   知识：            （列出全部）
//   /忘 淮蚌          （删除）
//   忘掉：淮蚌
//
// 返回 { action: 'teach'|'list'|'forget'|null, ... }
export function parseTeachCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { action: null };

  const prefixes = [
    /^\/教\s*/, /^教[:：]\s*/, /^记住[:：]\s*/, /^记[:：]\s*/, /^\/记\s*/,
    /^\/知识\s*/, /^知识[:：]\s*/, /^\/忘\s*/, /^忘掉[:：]\s*/, /^忘[:：]\s*/, /^\/忘知识\s*/,
  ];
  let matched = null;
  let body = null;
  for (const re of prefixes) {
    if (re.test(raw)) { matched = re; body = raw.replace(re, '').trim(); break; }
  }
  if (!matched) return { action: null };

  const src = matched.source;
  const isForget = src.includes('忘');
  const isList = src.includes('知识');

  if (isForget) return { action: 'forget', query: body };
  if (isList) return { action: 'list', query: body };

  if (!body) return { action: 'teach', error: '内容为空' };
  // 长文本=直接当典故/规则；含等号且等号前较短=词条。
  const eqIdx = body.search(/[=＝]/);
  if (eqIdx >= 0 && eqIdx <= 40) {
    // 等号在开头说明忘了写词条名，别把 "= 蚌埠" 整条当典故存进去。
    if (eqIdx === 0) return { action: 'teach', error: '等号左边要写词条名（如：教：淮蚌 = 蚌埠）' };
    const title = sanitizeKnowledgeText(body.slice(0, eqIdx), 60);
    const content = sanitizeKnowledgeText(body.slice(eqIdx + 1), 600);
    if (!title || !content) return { action: 'teach', error: '等号两边都要有内容（词条=含义）' };
    return { action: 'teach', kind: KNOWLEDGE_KINDS.TERM, title, content };
  }
  const content = sanitizeKnowledgeText(body, 600);
  if (!content) return { action: 'teach', error: '内容为空' };
  return { action: 'teach', kind: KNOWLEDGE_KINDS.FACT, title: '', content };
}
