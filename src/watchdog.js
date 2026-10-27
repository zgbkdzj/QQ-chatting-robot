// 会话救活巡检（Session rescue watchdog）
//
// ── 背景：一个真实存在、且已经被修过又丢了的 bug ──────────────────────────────
// HANDOFF 补丁清单第 3 条记录过「幽灵忙看门狗（60s 巡检）」，但当前代码里**没有**
// （搜索 `看门狗|幽灵` 零匹配）——补丁被上游覆盖后没重打。
//
// ── owner 指定的语义（2026-10-11，明确要求）──────────────────────────────────
//   「难道不是检测到 DSH 空闲就直接强制唤醒吗？之前就是这样的。」
//
// 所以本巡检**不是**「等宽限期再动手」，而是：
//   **DSH 侧该会话空闲（无活动 turn）+ 还有未读 + 没有在途唤醒 → 立即强制唤醒。**
// 这正是机器人「该说话却一直沉默」的自救机制：无限潜水会话没有定时器兜底，
// DSH 重启后积压未读无人处理，靠它把会话拉回来。
//
// ── 两种需要救活的情形 ───────────────────────────────────────────────────────
//   ① 孤儿未读：消息进了 unread，但唤醒意图（pendingWakeReasons）已被 DSH 重启时的
//      finally 清空 → 无人回头看 → 长期沉睡（实测积压 12 天）。
//   ② 幽灵忙：桥接仍标 busy（pendingWakeKeys / v2TurnStartAt / collectors），
//      但 DSH 侧 turn 已消失 → 没有 turn/end 回来清标记 → 永久 busy。
//      这种要先清 busy 标记，唤醒才排得进去。
//
// ⚠️ 安全约束（避免打断正在进行的回合）：
//   · **桥接侧确认该会话有 turn 在跑**（hasActiveTurn：v2TurnStartAt / collectors）→ 绝不干预；
//   · DSH 侧确认有活动 turn（next-turn/next-step 非空）→ 绝不干预（兜底）；
//   · DSH 查询失败（null）→ 保守跳过本轮，不误伤；
//   · 已有在途唤醒/定时器（pendingWakeTimer / pendingWakeKeys）→ 跳过，避免连环唤醒。
//
// ⚠️⚠️ 2026-10-22 修：曾把 DSH 的 inbox 队列长度当唯一"在跑"判据，结果**误伤正在进行的对话**。
//   owner 实测：「对话还在进行中，却又被唤醒多次」。
//   根因：session/projections 的 inbox 只表示"还有 prompt **排在队列里**"。
//   一旦 agent 领走 prompt（开始生成、调工具、或在 qq_wait_for_messages 里等人回话），
//   inbox 就空了 → dshTurnAlive 返回 false → 看门狗判定"空闲" → 强行唤醒，把回合打断。
//   且该投影对多数会话根本不返回 values（实测 hasValues=false），等于常年误判。
//   现在：**桥接自己的 v2TurnStartAt / collectors 才是权威信号**（turn/start 记、turn/end 删，
//   精确对应"这一会话有回合在跑"）；DSH 的 inbox 只作兜底辅助。

/** 巡检周期（毫秒） */
export const WATCHDOG_INTERVAL_MS = 60_000;

/**
 * 构造巡检器。依赖全部注入（不直接 import bridge 内部状态），便于单测。
 *
 * @param {object} deps
 * @param {() => string[]} deps.listKeys            所有二代会话 key
 * @param {(key:string) => string|null} deps.sessionIdFor  取会话的 DSH sessionId
 * @param {(sid:string) => Promise<boolean|null>} deps.dshTurnAlive
 *        DSH 侧该会话是否真有 turn 在跑。true=在跑，false=空闲，null=查不到（保守跳过）
 * @param {(key:string) => number} deps.unreadCount  该会话积压的未读数
 * @param {(key:string) => boolean} deps.hasInFlightWake 是否已有在途唤醒/定时器
 * @param {(key:string) => boolean} deps.isBusy      桥接侧是否标忙（幽灵忙判定用）
 * @param {(key:string) => number} [deps.activeTurnAgeMs]
 *       该会话当前回合已持续的毫秒数（无回合返回 0）。
 *       ⚠️ 2026-10-22 用它区分"真在跑"与"幽灵忙"：同一个 v2TurnStartAt 标记
 *       既是"有回合在跑"（该保护）的证据，也是"回合卡死"（该清理）的证据，
 *       只看布尔值分不清 —— 必须看年龄。配合 turnStaleMs 使用。
 * @param {number} [deps.turnStaleMs]
 *       回合持续超过多久才算"卡死/幽灵忙"。默认 **20 分钟**。
 *       ⚠️ 必须 **大于** AI 的最长正常等待（preSleepWaitMs=5min、wait 工具上限 15min），
 *       否则会把"正常在等消息"的回合误判成卡死，反复打断对话（2026-10-24 实测事故：
 *       5min 租约 = 5min 等待 → 每 5 分钟打断一次，turn=1 跑到 step=34）。
 * @param {(key:string) => boolean} [deps.isWaitingMessages]
 *       该会话是否正在 qq_wait_for_messages 里等待。true → **绝不干预**（正常工作）。
 * @param {(key:string) => void} deps.forceClearBusy 强制清 busy 标记
 * @param {(key:string) => void} deps.resendWake     直接强制唤醒
 * @param {(msg:string) => void} deps.log
 */
export function createWatchdog(deps) {
  const {
    listKeys, sessionIdFor, dshTurnAlive, unreadCount, hasInFlightWake,
    isBusy, forceClearBusy, resendWake, activeTurnAgeMs, isWaitingMessages,
    log = () => {}, turnStaleMs = 20 * 60 * 1000,
  } = deps;

  async function tick() {
    for (const key of listKeys()) {
      try {
        // 没有积压就不必打扰
        const unread = unreadCount(key);
        if (!unread) continue;

        // ⚠️⚠️ 2026-10-24 定稿：**先问 DSH"这个会话到底有没有回合在跑"**（最高优先级）。
        //
        // owner 指出的语义：「看门狗应该只在检测到幽灵忙时解除，正常忙不该触发强制唤醒。」
        // 完全正确 —— 判据必须是 **DSH 侧的真实活动状态**，而不是"桥接标了多久忙"。
        //
        // `dshTurnAlive` 现在读 `liveTokenStats.active`（DSH 自己报的活动回合）：
        //   · active 非 null → 真在跑（含模型生成 / 工具调用 / qq_wait_for_messages 等待）
        //     → **绝不干预**，连 busy 标记都不动
        //   · active === null 且 inbox 空 → 确认空闲 → 才可能判定幽灵忙
        //   · 查询失败/null → 保守跳过本轮
        //
        // 历史教训（两版都错在这）：
        //   ① 用 inbox 长度 → 实测永远空数组，等于没判断；
        //   ② 用回合年龄猜 → 5min 租约 = 5min 等待，把正常对话当卡死，反复打断。
        const sid = sessionIdFor?.(key) || null;
        let alive = null;
        if (sid && dshTurnAlive) {
          try { alive = await dshTurnAlive(sid); } catch { alive = null; }
        }
        // DSH 确认有活动回合 → 真忙，绝不干预（这才是"正常忙"的正确识别方式）
        if (alive === true) continue;
        // 查不到 → 保守跳过本轮（可能是网络抖动，别误伤）
        if (alive === null) continue;

        // ── 到这里说明 DSH 已确认空闲 ──
        // 若桥接侧还残留"回合在跑"的标记 → 那个回合**已经死了**（DSH 都说没有），
        // 这才是真正的"幽灵忙"，可以清理。用极长兜底（turnStaleMs）避免 DSH
        // 活动统计延迟造成误判：刚启动不到阈值的回合先放过，等下一轮再确认。
        if (activeTurnAgeMs && isWaitingMessages?.(key)) continue;   // 正在 wait → 不动
        const age = activeTurnAgeMs?.(key) ?? 0;
        if (age > 0 && age < turnStaleMs) continue;   // 回合还"年轻"，等下一轮确认

        // 已经有排队中的唤醒/定时器（pendingWakeTimer / pendingWakeKeys）→ 别重复排
        if (hasInFlightWake(key)) continue;

        // ── DSH 空闲 + 桥接可能幽灵忙 → 救活 ──
        if (isBusy?.(key)) {
          log(`[看门狗] ${key} 幽灵忙（DSH 确认无活动回合，桥接仍标忙），强制清理 busy`);
        }
        try { forceClearBusy(key); } catch (error) { log(`[看门狗] ${key} 清理 busy 失败：${error?.message ?? error}`); }
        log(`[看门狗] ${key} DSH 空闲但积压 ${unread} 条未读且无在途唤醒 → 强制唤醒`);
        try { resendWake(key); } catch (error) { log(`[看门狗] ${key} 强制唤醒失败：${error?.message ?? error}`); }
      } catch (error) {
        log(`[看门狗] 巡检 ${key} 异常：${error?.message ?? error}`);
      }
    }
  }

  return {
    tick,
    start() {
      if (this._timer) return;
      this._timer = setInterval(() => { void tick(); }, WATCHDOG_INTERVAL_MS);
      this._timer.unref?.();
      log(`[看门狗] 已启动，每 ${Math.round(WATCHDOG_INTERVAL_MS / 1000)}s 巡检一次（DSH 空闲即强制唤醒积压会话）`);
    },
    stop() {
      if (!this._timer) return;
      clearInterval(this._timer);
      this._timer = null;
    },
  };
}
