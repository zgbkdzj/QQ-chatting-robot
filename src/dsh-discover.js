// DSH 端口自动发现：DSH 重启后端口会随机变（19387 → 50760 → 63979），
// 而桥接 config 里的 dsh.baseUrl 是写死的，导致连不上。
//
// 识别方法（实测可行）：DSH 的 Web 端在未鉴权时返回
//   HTTP 401 + body 以 "dsh web authentication required" 开头
// 这是 DSH 独有的特征文案，其它服务（Kestrel 404、403、200 html）都不匹配。
//
// 扫描策略：先试配置里的端口（快路径），失败再扫一段高位端口。
// 用 TCP 并发探测缩小范围，再对候选发 HTTP 请求做特征判定。
//
// ⚠️⚠️ 2026-10-22 修：扫描上限从 60000 改成 **65535**。
//   原来写死 60000，而 DSH 用的端口来自 Windows 动态端口范围
//   `netsh int ipv4 show dynamicport tcp` = **49152~65535（16384 个）**。
//   即 60001~65535 这 5535 个端口（约 1/3 概率）**从来没被扫过** ——
//   DSH 一旦落到这个区间，桥接就永远发现不了，每 20 秒重试一次，
//   消息全部堆积（实测 21:28 owner 收到「已排队 7 条」就是因为 DSH 在 63979）。
//   顺带把 scanFrom 从 20000 降到 1024：低位也可能被占用（DSH 曾经用过 19387 这类）。

import net from 'node:net';

const DSH_401_MARK = 'dsh web authentication required';

function tcpOpen(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (ok) => { if (!done) { done = true; s.destroy(); resolve(ok); } };
    s.setTimeout(timeoutMs);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, host);
  });
}

/** 该端口是否是 DSH Web（靠 401 特征文案判定，鉴权与否都能识别）。 */
export async function isDshWebPort(port, host = '127.0.0.1', timeoutMs = 2500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`http://${host}:${port}/`, { signal: ac.signal, redirect: 'manual' });
    if (r.status !== 401) return false;
    const body = await r.text().catch(() => '');
    return body.trimStart().startsWith(DSH_401_MARK);
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 自动发现 DSH Web 端口。
 * @param {string} configuredBaseUrl - config 里配的 baseUrl（优先试它，省一次扫描）
 * @param {object} opts
 * @param {number[]} opts.extraPorts - 额外优先尝试的端口（如上次成功的）
 * @returns {Promise<{baseUrl:string, port:number, source:'config'|'extra'|'scan'}|null>}
 */
export async function discoverDshWebPort(configuredBaseUrl, opts = {}) {
  const host = '127.0.0.1';
  // 扫描范围必须覆盖 Windows 动态端口全集（49152~65535）。
  // 旧值 scanTo=60000 漏掉 5535 个端口，DSH 落到那里就永远发现不了。
  const { extraPorts = [], scanFrom = 1024, scanTo = 65535, log = () => {} } = opts;

  // 1) 先试配置的端口
  try {
    const u = new URL(String(configuredBaseUrl));
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]') {
      const p = Number(u.port);
      if (p > 0 && (await isDshWebPort(p, host))) {
        return { baseUrl: `http://127.0.0.1:${p}`, port: p, source: 'config' };
      }
    }
  } catch { /* baseUrl 不可解析，继续扫 */ }

  // 2) 试额外端口（上次成功过的）
  for (const p of extraPorts) {
    if (p > 0 && (await isDshWebPort(p, host))) {
      return { baseUrl: `http://127.0.0.1:${p}`, port: p, source: 'extra' };
    }
  }

  // 3) TCP 并发扫高位端口，再对候选做特征判定。
  //    ⚠️ 分两段扫，且**高位段优先**：DSH 的端口来自 Windows 动态端口范围
  //    （49152~65535），绝大多数情况落在那里；先扫它能省掉大半时间。
  //    低位段（1024~49151）只是兜底（DSH 早年在 19387 这类端口待过）。
  //    范围上限必须是 65535 —— 曾经写死 60000，漏掉 5535 个端口，
  //    导致 DSH 落在 63979 时桥接永远发现不了（2026-10-22 实测）。
  const candidates = [];
  const scanRange = async (from, to) => {
    const ports = [];
    for (let p = from; p <= to; p++) ports.push(p);
    const BATCH = 1000;   // 并发再大一点：范围扩大了，保持总耗时可控
    for (let i = 0; i < ports.length; i += BATCH) {
      const slice = ports.slice(i, i + BATCH);
      const res = await Promise.all(slice.map((p) => tcpOpen(p, host, 700).then((ok) => (ok ? p : null))));
      for (const p of res) if (p) candidates.push(p);
    }
  };
  await scanRange(49152, scanTo);          // 高位段优先（DSH 的主战场）
  log(`端口扫描：${candidates.length} 个开放候选（高位段）`);
  for (const p of candidates) {
    if (await isDshWebPort(p, host)) {
      return { baseUrl: `http://127.0.0.1:${p}`, port: p, source: 'scan' };
    }
  }
  // 高位段没找到再扫低位段兜底
  if (scanFrom < 49152) {
    candidates.length = 0;
    await scanRange(scanFrom, 49151);
    log(`端口扫描：${candidates.length} 个开放候选（低位段）`);
    for (const p of candidates) {
      if (await isDshWebPort(p, host)) {
        return { baseUrl: `http://127.0.0.1:${p}`, port: p, source: 'scan' };
      }
    }
  }
  return null;
}
