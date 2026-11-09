/**
 * 天官书 · 账本（T-ledger）
 *
 * 契约：CONTRACT.md §6
 *   - 存储：<rootDir>/records/<YYYY>/<MM>.jsonl，一行一个 card 全量 JSON。
 *   - 追加写、不重写；同一 card_id 重复写入时带递增 revision（从 0 开始）。
 *   - 附带 recorded_at（Asia/Shanghai，ISO8601 带 +08:00）。
 *
 * 实现约定（契约未明说处）：
 *   - 年月分区以 card.as_of 的日期为准（缺省 as_of 时退回 recorded_at）。
 *   - appendRecord 返回该条记录所在文件（.jsonl）的绝对路径。
 *   - listRecords 按 as_of、recorded_at、revision 升序输出；无法解析或非对象的
 *     行被跳过，跳过条数挂在返回数组的非枚举属性 skipped_lines 上。
 *   - readRecord 支持 card_id（取 revision 最大/最新的一条）、.jsonl 文件路径
 *     （取该文件最后一条）以及 "文件路径#L<行号>"（取物理行）。
 *
 * 纯 ESM，零运行时依赖，Node >= 20。
 */

import fs from 'node:fs';
import path from 'node:path';

import { nowShanghai } from '../provenance.mjs';

const RECORDS_DIRNAME = 'records';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 解析 YYYY-MM-DD 前缀（也接受完整 ISO8601 时间戳），校验日历合法性。
 * @returns {{ year: string, month: string, day: string, stamp: number } | null}
 */
function parseDayParts(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[Tt ])/.exec(value.trim());
  if (!match) return null;
  const year = match[1];
  const month = match[2];
  const day = match[3];
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return null;
  const stamp = Date.UTC(Number(year), monthNumber - 1, dayNumber);
  const probe = new Date(stamp);
  if (
    probe.getUTCFullYear() !== Number(year) ||
    probe.getUTCMonth() !== monthNumber - 1 ||
    probe.getUTCDate() !== dayNumber
  ) {
    return null;
  }
  return { year, month, day, stamp };
}

function partitionFor(card, fallbackRecordedAt) {
  const fromAsOf = parseDayParts(card.as_of);
  if (fromAsOf !== null) return { year: fromAsOf.year, month: fromAsOf.month };
  return {
    year: fallbackRecordedAt.slice(0, 4),
    month: fallbackRecordedAt.slice(5, 7),
  };
}

/** 列出 records/ 下全部 .jsonl（递归，按路径排序）。 */
function collectRecordFiles(recordsDir) {
  const files = [];
  if (!fs.existsSync(recordsDir)) return files;
  const stack = [recordsDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }
  files.sort();
  return files;
}

/**
 * 解析单行。空行不算坏行（不计数）；JSON 解析失败或解析结果非对象按坏行处理。
 * @returns {{ status: 'empty' } | { status: 'bad' } | { status: 'ok', record: object }}
 */
function parseJsonLine(rawLine, isFirstLine) {
  let line = rawLine;
  if (line.endsWith('\r')) line = line.slice(0, -1);
  if (isFirstLine && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
  if (line.trim() === '') return { status: 'empty' };
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { status: 'bad' };
  }
  if (!isPlainObject(parsed)) return { status: 'bad' };
  return { status: 'ok', record: parsed };
}

/** @returns {number} 被跳过的坏行数 */
function parseJsonlFile(filePath, onRecord) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  let skipped = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseJsonLine(lines[i], i === 0);
    if (parsed.status === 'empty') continue;
    if (parsed.status === 'bad') {
      skipped += 1;
      continue;
    }
    onRecord(parsed.record);
  }
  return skipped;
}

function scanRecords(rootDir) {
  const records = [];
  let skippedLines = 0;
  for (const filePath of collectRecordFiles(path.join(path.resolve(rootDir), RECORDS_DIRNAME))) {
    skippedLines += parseJsonlFile(filePath, (record) => records.push(record));
  }
  return { records, skipped_lines: skippedLines };
}

function timestampOf(value) {
  if (typeof value !== 'string') return null;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? stamp : null;
}

function revisionOf(record) {
  return Number.isInteger(record.revision) && record.revision >= 0 ? record.revision : 0;
}

function compareRecords(a, b) {
  const aAsOf = timestampOf(a.as_of) ?? timestampOf(a.recorded_at) ?? 0;
  const bAsOf = timestampOf(b.as_of) ?? timestampOf(b.recorded_at) ?? 0;
  if (aAsOf !== bAsOf) return aAsOf - bAsOf;

  const aRecordedAt = timestampOf(a.recorded_at) ?? 0;
  const bRecordedAt = timestampOf(b.recorded_at) ?? 0;
  if (aRecordedAt !== bRecordedAt) return aRecordedAt - bRecordedAt;

  return revisionOf(a) - revisionOf(b);
}

function nextRevision(rootDir, cardId) {
  if (!isNonEmptyString(cardId)) return 0;
  let seen = false;
  let maxRevision = 0;
  for (const record of scanRecords(rootDir).records) {
    if (record.card_id !== cardId) continue;
    seen = true;
    const revision = revisionOf(record);
    if (revision > maxRevision) maxRevision = revision;
  }
  return seen ? maxRevision + 1 : 0;
}

/**
 * 追加写入一条 card 记录。
 *
 * @param {object} card 七政卡（原样写入，不修改入参）
 * @param {string} [rootDir] 项目根目录，默认当前工作目录
 * @returns {string} 写入文件（.jsonl）的绝对路径
 */
export function appendRecord(card, rootDir = process.cwd()) {
  if (!isPlainObject(card)) {
    throw new TypeError('appendRecord(card, rootDir): card must be a plain object');
  }

  const root = path.resolve(rootDir);
  const recordedAt = nowShanghai();
  const { year, month } = partitionFor(card, recordedAt);
  const dir = path.join(root, RECORDS_DIRNAME, year);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${month}.jsonl`);
  const revision = nextRevision(root, card.card_id);
  const record = { ...card, revision, recorded_at: recordedAt };

  // 追加写：每次只写一行，避免整文件读取/重写；O_APPEND 保证并发下不互相覆盖。
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  return filePath;
}

/**
 * 读出全部记录（跨年月），按 as_of → recorded_at → revision 升序。
 * 返回数组的非枚举属性 skipped_lines 记录被跳过的坏行数。
 *
 * @param {string} [rootDir]
 * @returns {object[]}
 */
export function listRecords(rootDir = process.cwd()) {
  const { records, skipped_lines: skippedLines } = scanRecords(rootDir);
  records.sort(compareRecords);
  Object.defineProperty(records, 'skipped_lines', {
    value: skippedLines,
    enumerable: false,
    configurable: true,
  });
  return records;
}

function looksLikePath(ref) {
  return (
    ref.endsWith('.jsonl') ||
    ref.includes('/') ||
    ref.includes('\\') ||
    path.isAbsolute(ref) ||
    /^[A-Za-z]:[\\/]/.test(ref)
  );
}

function resolveExistingFile(root, ref) {
  const candidates = path.isAbsolute(ref)
    ? [ref]
    : [path.resolve(root, ref), path.resolve(root, RECORDS_DIRNAME, ref)];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 候选路径不存在，继续尝试下一个。
    }
  }
  return null;
}

function findLatestByCardId(rootDir, cardId) {
  let best = null;
  for (const record of scanRecords(rootDir).records) {
    if (record.card_id !== cardId) continue;
    if (best === null) {
      best = record;
      continue;
    }
    const bestRevision = revisionOf(best);
    const revision = revisionOf(record);
    if (revision !== bestRevision) {
      if (revision > bestRevision) best = record;
      continue;
    }
    const bestRecordedAt = timestampOf(best.recorded_at) ?? 0;
    const recordedAt = timestampOf(record.recorded_at) ?? 0;
    if (recordedAt >= bestRecordedAt) best = record;
  }
  return best;
}

function readRecordsFromFile(filePath) {
  const records = [];
  parseJsonlFile(filePath, (record) => records.push(record));
  return records;
}

/**
 * 按 card_id 或记录路径读取单条记录。
 *   - card_id：返回 revision 最大（同 revision 取最新 recorded_at）的一条。
 *   - 文件路径：返回该 .jsonl 的最后一条记录。
 *   - "文件路径#L<行号>"：返回该物理行（1 起）。
 *
 * @param {string} ref
 * @param {string} [rootDir]
 * @returns {object | null}
 */
export function readRecord(ref, rootDir = process.cwd()) {
  if (typeof ref !== 'string') return null;
  const trimmed = ref.trim();
  if (trimmed === '') return null;

  const root = path.resolve(rootDir);
  const hashIndex = trimmed.lastIndexOf('#');
  const filePart = hashIndex > 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const anchor = hashIndex > 0 ? trimmed.slice(hashIndex + 1) : null;

  if (anchor === null && !looksLikePath(filePart)) {
    return findLatestByCardId(root, filePart);
  }

  const filePath = resolveExistingFile(root, filePart);
  if (filePath === null) return null;

  if (anchor !== null) {
    const match = /^L(\d+)$/i.exec(anchor);
    if (match === null) return null;
    const lineNumber = Number(match[1]);
    if (!Number.isInteger(lineNumber) || lineNumber < 1) return null;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    const rawLine = lines[lineNumber - 1];
    if (rawLine === undefined) return null;
    const parsed = parseJsonLine(rawLine, lineNumber === 1);
    return parsed.status === 'ok' ? parsed.record : null;
  }

  const records = readRecordsFromFile(filePath);
  return records.length > 0 ? records[records.length - 1] : null;
}

/**
 * 最小结构校验（只校验卡片骨架，不做业务规则校验）。
 *
 * @param {unknown} card
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function verifyRecord(card) {
  if (!isPlainObject(card)) {
    return { ok: false, errors: ['card must be a plain object'] };
  }

  const errors = [];

  if (!isNonEmptyString(card.card_id)) {
    errors.push('card_id is required and must be a non-empty string');
  }
  if (!isNonEmptyString(card.symbol)) {
    errors.push('symbol is required and must be a non-empty string');
  }
  if (!isNonEmptyString(card.verdict)) {
    errors.push('verdict is required and must be a non-empty string');
  }
  if (!isPlainObject(card.horizons)) {
    errors.push('horizons is required and must be an object');
  }

  return { ok: errors.length === 0, errors };
}
