/**
 * 天市 · 七政卡 → Markdown 报告
 * 纯渲染，不做任何计算，不引入任何数据。
 */

const DIR_LABEL = { up: '看多 ↑', flat: '震荡 →', down: '看空 ↓', unknown: '无法判断 ?' };
const VERDICT_LABEL = { buy: '买入', watch: '观察', avoid: '回避', incomplete: '分析未完成' };
const GATE_LABEL = { data: '数据闸', consistency: '一致性闸', sample: '样本闸', counter: '反证闸', extreme: '极端值闸' };
const GATE_ICON = { pass: '✅', warn: '⚠️', fail: '❌' };


/** 把文本里的裸数字格式化成 亿/万，便于阅读（仅用于 triggers 等自由文本） */
function fmtBareNumbers(text) {
  if (typeof text !== 'string') return String(text ?? '');
  return text.replace(/(-?\d{7,})(?=\s*元|\b)/g, (m) => {
    const n = Number(m);
    if (!Number.isFinite(n)) return m;
    const a = Math.abs(n);
    if (a >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
    if (a >= 1e4) return `${(n / 1e4).toFixed(2)} 万`;
    return m;
  }).replace(/亿 元/g, '亿').replace(/万 元/g, '万');
}

function money(v) {
  if (v === null || v === undefined) return '无数据';
  const a = Math.abs(v);
  if (a >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
  if (a >= 1e4) return `${(v / 1e4).toFixed(2)} 万`;
  return String(v);
}
const pct = (v) => (v === null || v === undefined ? '无数据' : `${Number(v).toFixed(2)}%`);
const px = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(2));

export function renderReport(card, facts) {
  const L = [];
  const h = card.horizons;

  L.push(`# 天市 · 七政卡 — ${card.symbol} ${card.name ?? ''}`);
  L.push('');
  L.push(`> **翟星人的实验室** 出品 ｜ 数据时点：${card.data_as_of} ｜ 生成：${card.as_of} ｜ 卡片：\`${card.card_id}\``);
  L.push(`> **本报告所有数字均来自真实工具调用的原始返回，可在 \`evidence/\` 目录按 sha256 校验。**`);
  L.push('');

  // 能力边界警示（放在最前面：先让读者知道哪些结论不能信）
  const vd = card.validation?.directional;
  const vr = card.validation?.risk_grading;
  if (vd) {
    L.push('> [!WARNING]');
    L.push(`> **方向预测未通过样本外验证**：${vd.claim}。`);
    const h = vd.by_horizon ?? {};
    L.push(`> 实测方向命中率：短线 ${(h.short?.hit_rate * 100).toFixed(1)}% / 中线 ${(h.mid?.hit_rate * 100).toFixed(1)}% / 长线 ${(h.long?.hit_rate * 100).toFixed(1)}%（低于 50% 即等同随机或更差）。`);
    L.push('> 因此本报告**不提供方向性买入建议**，下表的「方向/概率」仅供追溯，不构成依据。');
    if (vr) L.push(`> 相比之下，**风险分级已验证有效**：${vr.claim}（R1 回撤 ${vr.by_level?.[1]?.median_max_dd}% → R5 ${vr.by_level?.[5]?.median_max_dd}%）。`);
    L.push('');
  }

  // 一句话结论
  L.push(`## 结论：${VERDICT_LABEL[card.verdict] ?? card.verdict}`);
  L.push('');
  if (card.verdict === 'watch') L.push('> 观察不等于看多：这是「不构成买入理由」的意思。是否值得进一步研究，看下方条件清单。');
  if (card.verdict === 'avoid') L.push('> 当前的回避理由是**风险过高**，与方向判断无关。');
  L.push('');

  // 三周期
  L.push('### 方向信号（未通过验证，仅供追溯）');
  L.push('');
  L.push('| 周期 | 方向 | 上行概率 | 区间 | 独立样本 | 失效条件 |');
  L.push('|---|---|---|---|---|---|');
  for (const [k, label] of [
    ['short', '短线 1-5 日'],
    ['mid', '中线 1-3 月'],
    ['long', '长线 12 月'],
  ]) {
    const x = h[k];
    if (!x) continue;
    const range = x.range ? `${px(x.range[0])} ~ ${px(x.range[1])}` : '—';
    L.push(`| ${label} | ${DIR_LABEL[x.dir] ?? x.dir} | ${x.prob_up === null ? '—' : (x.prob_up * 100).toFixed(1) + '%'} | ${range} | ${x.sample_n ?? '—'} | ${x.invalid_if ?? '—'} |`);
  }
  L.push('');

  // 各周期依据（含「无数据」声明与样本约束说明）
  L.push('## 各周期依据');
  L.push('');
  for (const [k, label] of [
    ['short', '短线 1-5 日'],
    ['mid', '中线 1-3 月'],
    ['long', '长线 12 月'],
  ]) {
    const x = h[k];
    if (!x) continue;
    L.push(`**${label}**（独立样本 ${x.sample_n ?? '—'}，置信上限 ${x.confidence_cap == null ? '—' : (x.confidence_cap * 100).toFixed(0) + '%'}）`);
    for (const d of x.drivers ?? []) L.push(`- ${d}`);
    if (!x.drivers?.length) L.push('- 无');
    L.push('');
  }

  // 风险
  const r = card.risk;
  L.push('## 风险与仓位（玉衡）');
  L.push('');
  L.push(`- **风险等级：R${r.level} / 5**`);
  L.push(`- 单票仓位上限：**${r.position_cap_pct}%**`);
  L.push(`- 止损线：**${r.stop_loss_pct === null ? '不适用' : r.stop_loss_pct + '%'}**`);
  L.push(`- 回撤估计：${r.drawdown_est}`);
  if (r.triggers?.length) {
    L.push(`- 触发依据：`);
    for (const t of r.triggers) L.push(`  - ${fmtBareNumbers(t)}`);
  }
  L.push('');

  // 值得考虑的条件
  if (card.buy_conditions) {
    const bc = card.buy_conditions;
    L.push('## 值得考虑的条件（全部满足才叫「可以研究」，不是买入信号）');
    L.push('');
    L.push(`当前满足 **${bc.met_count} / ${bc.conditions.length}** 条。`);
    L.push('');
    L.push('| 条件 | 当前实际 | 状态 |');
    L.push('|---|---|---|');
    for (const c of bc.conditions) {
      L.push(`| ${c.text} | ${c.current} | ${c.met ? '✅ 满足' : '❌ 不满足'} |`);
    }
    L.push('');
    if (!bc.all_met) L.push('> 未全部满足 → 即使你主观看好，也还不到「可以考虑」的时点。缺哪一条已在上面标出。');
    L.push('');
  }

  // 五道闸
  L.push('## 五道闸（程序判定）');
  L.push('');
  L.push('| 闸 | 结果 | 说明 |');
  L.push('|---|---|---|');
  for (const [k, name] of Object.entries(GATE_LABEL)) {
    const g = card.gates[k];
    if (!g) continue;
    L.push(`| ${name} | ${GATE_ICON[g.status] ?? g.status} ${g.status} | ${g.detail} |`);
  }
  L.push('');

  // 引用到的证据
  L.push('## 引用证据');
  L.push('');
  for (const e of card.evidence ?? []) {
    L.push(`- ${e.claim}（${e.source}${e.as_of ? '，' + e.as_of : ''}）`);
  }
  if (!card.evidence?.length) L.push('- 无');
  L.push('');

  // 反证
  L.push('## 反证');
  L.push('');
  for (const c of card.counter_evidence ?? []) L.push(`- ${c.claim}`);
  if (!card.counter_evidence?.length) L.push('- **未找到反证 → 分析不成立**');
  L.push('');

  // 无数据项
  if (card.missing?.length) {
    L.push('## 本轮无数据项');
    L.push('');
    L.push('> 以下维度**本轮未纳入判断**，不构成「没有风险」的证据。');
    L.push('');
    for (const m of card.missing) L.push(`- ${m}`);
    L.push('');
  }

  // 证据清单
  if (facts?.evidence?.length) {
    L.push('## 证据清单（可校验）');
    L.push('');
    L.push('| 证据 ID | 来源 | 采集时刻 | sha256(前12) | 原始文件 |');
    L.push('|---|---|---|---|---|');
    for (const e of facts.evidence) {
      L.push(`| \`${e.evidence_id}\` | ${e.source} | ${e.fetched_at} | \`${(e.raw_sha256 || '').slice(0, 12)}\` | ${e.raw_path} |`);
    }
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push('| **出品** | 翟星人的实验室（ZLab） |');
  L.push('| **数据源** | 腾讯财经 / 东方财富 公开接口 |');
  L.push('| **可追溯** | 原始响应落盘 + sha256，可用 `node cli.mjs verify` 离线复算 |');
  L.push('| **免责** | 本报告仅供研究参考，不构成投资建议。数据可能存在延迟、口径差异或上游错误，请以交易软件为准。 |');
  return L.join('\n');
}
