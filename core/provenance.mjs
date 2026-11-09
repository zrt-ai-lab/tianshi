/**
 * 天市 · 证据链（provenance）
 *
 * 第一原则：数必有据。
 * 每一份进入分析的数据，都必须留下三样东西：
 *   1. 原始响应字节（原样落盘，不转码、不改写）
 *   2. 原始字节的 sha256（事后可校验没被篡改）
 *   3. 来源 URL + 采集时刻（带 +08:00 时区）
 *
 * 没有这三样的数字，不允许进入七政卡。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';

const TZ_OFFSET_MIN = 8 * 60; // Asia/Shanghai，固定 +08:00（中国无夏令时）

/** 当前时刻，ISO8601 带 +08:00。禁止用 toISOString() 当业务时间。 */
export function nowShanghai(date = new Date()) {
  const t = new Date(date.getTime() + TZ_OFFSET_MIN * 60_000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}` +
    `T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+08:00`
  );
}

/** 今天的日期 YYYY-MM-DD（上海时区） */
export function todayShanghai(date = new Date()) {
  return nowShanghai(date).slice(0, 10);
}

/** 紧凑日期 YYYYMMDD，用于路径与 ID */
export function compactDate(date = new Date()) {
  return todayShanghai(date).replaceAll('-', '');
}

/** sha256 of raw bytes */
export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 原始响应落盘。
 * @param {Buffer} buf 原始字节
 * @param {string} relPath 相对项目根的路径，如 evidence/20261109/600519/tencent_quote.txt
 * @param {string} rootDir 项目根
 * @returns {{raw_path:string, raw_sha256:string}}
 */
export function saveRaw(buf, relPath, rootDir) {
  const abs = isAbsolute(relPath) ? relPath : join(rootDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buf);
  return { raw_path: relPath, raw_sha256: sha256(buf) };
}

/** 校验一份落盘证据没被改动过 */
export function verifyRaw(relPath, expectedSha, rootDir) {
  const abs = isAbsolute(relPath) ? relPath : join(rootDir, relPath);
  if (!existsSync(abs)) return { ok: false, reason: 'raw file missing' };
  const actual = sha256(readFileSync(abs));
  return { ok: actual === expectedSha, reason: actual === expectedSha ? null : 'sha256 mismatch' };
}

/** 构造一条证据记录 */
export function makeEvidence({
  source,
  endpoint,
  fetched_at,
  raw_sha256,
  raw_path,
  encoding = 'utf-8',
  ok = true,
  error = null,
  evidence_id,
}) {
  if (!evidence_id) throw new Error('evidence_id is required');
  return { evidence_id, source, endpoint, fetched_at, raw_sha256, raw_path, encoding, ok, error };
}

/** 证据 ID：ev_<YYYYMMDD>_<symbol>_<source>_<kind> */
export function evidenceId(symbol, source, kind, date = new Date()) {
  return `ev_${compactDate(date)}_${symbol}_${source}_${kind}`;
}

/** 建一个 evidence 索引，供七政卡校验用 */
export function evidenceIndex(facts) {
  const m = new Map();
  for (const e of facts.evidence ?? []) m.set(e.evidence_id, e);
  return m;
}

/** 断言：某对象上的 evidence_id 在证据表里存在 */
export function assertEvidence(obj, index, label) {
  const id = obj?.evidence_id;
  if (!id) return `${label}: 缺 evidence_id`;
  if (!index.has(id)) return `${label}: evidence_id "${id}" 不在证据表中`;
  return null;
}

/* ── Manifest：一次采集的证据清单，供离线审计 ───────────── */

import { readdirSync } from 'node:fs';

/**
 * 把一次采集的证据清单写入 evidence/<YYYYMMDD>/<code>/manifest.json
 * 这份清单是「事后审计」的依据：verify 只读它 + 校验哈希，不重新联网。
 */
export function saveManifest({ symbol, trade_date, fetched_at, evidence }, rootDir, now = new Date()) {
  const relPath = `evidence/${compactDate(now)}/${symbol}/manifest.json`;
  const abs = join(rootDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  const body = JSON.stringify({ symbol, trade_date, fetched_at, evidence }, null, 2);
  writeFileSync(abs, body, 'utf8');
  return { manifest_path: relPath };
}

/**
 * 读取某只股票最近一次的 manifest。
 * @returns {{manifest_path:string, data:object}|null}
 */
export function loadLatestManifest(symbol, rootDir) {
  const base = join(rootDir, 'evidence');
  if (!existsSync(base)) return null;
  const days = readdirSync(base)
    .filter((d) => /^\d{8}$/.test(d))
    .sort()
    .reverse();
  for (const d of days) {
    const p = join(base, d, symbol, 'manifest.json');
    if (existsSync(p)) {
      try {
        return { manifest_path: `evidence/${d}/${symbol}/manifest.json`, data: JSON.parse(readFileSync(p, 'utf8')) };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/* ── 证据链硬校验 ────────────────────────────────────────── */
/**
 * 契约 §2 的核心承诺：卡面上任何引用都必须能落回 facts.evidence。
 * validateCard 只做结构校验，这一层做「可追溯性」校验，二者不可互相替代。
 *
 * @returns {{ok:boolean, errors:string[], checked:number}}
 */
export function checkEvidenceChain(card, facts) {
  const errors = [];
  const index = evidenceIndex(facts ?? {});
  let checked = 0;

  const check = (id, where) => {
    if (id === null || id === undefined) return; // 允许无证据的定性条目
    checked++;
    if (!index.has(id)) errors.push(`${where}: evidence_id "${id}" 不在 facts.evidence 中`);
  };

  for (const [i, e] of (card.evidence ?? []).entries()) check(e?.evidence_id, `card.evidence[${i}]`);
  for (const [i, e] of (card.counter_evidence ?? []).entries()) check(e?.evidence_id, `card.counter_evidence[${i}]`);

  // facts 侧各数据块自称的 evidence_id 也必须真实存在
  const blocks = [
    ['quote', facts?.quote],
    ['fund_flow', facts?.fund_flow],
    ['fund_flow.today', facts?.fund_flow ? { evidence_id: facts.fund_flow.today_evidence_id } : null],
    ['financials', facts?.financials],
    ['valuation_pct', facts?.valuation_pct],
    ['sector', facts?.sector],
  ];
  for (const [name, block] of blocks) check(block?.evidence_id, `facts.${name}`);

  return { ok: errors.length === 0, errors, checked };
}
