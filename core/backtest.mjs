/**
 * 天市 · 回测引擎
 *
 * 目的不是「证明策略赚钱」，而是**证明这套判断有没有信息量**：
 *   - 方向命中率是否显著高于随机（50%）
 *   - 说 60% 上行的时候，实际涨了多少比例（概率校准）
 *   - 风险等级和实际最大回撤对不对得上
 *
 * 关键纪律：
 *   1. 出卡只吃 asof 之前的数据（sliceAsOf 保证），绝无未来函数
 *   2. 打分用 asof 之后的真实走势，两者物理隔离
 *   3. 卡片走和线上完全相同的 runPipeline
 */

import { fetchBag, sliceAsOf, measureOutcome } from './history.mjs';
import { runPipeline } from './pipeline.mjs';
import { score as scoreOutcomes } from './contract/calibrate.mjs';

const HORIZONS = ['short', 'mid', 'long'];
const norm = (c) => String(c).replace(/^(sh|sz|bj)/i, '');

/**
 * @param {string} code
 * @param {{start:string, end:string, stepDays?:number, rootDir?:string, years?:number, minBars?:number}} opts
 */
export async function runBacktest(code, opts = {}) {
  const { start, end, stepDays = 5, rootDir = '.', years = 3 } = opts;
  const bag = await fetchBag(code, { rootDir });

  const inRange = bag.kline.filter((b) => b.date >= start && b.date <= end);
  if (inRange.length === 0) throw new Error(`区间 ${start}~${end} 内没有交易日`);

  // 等距抽样，避免相邻日高度相关
  const dates = inRange.filter((_, i) => i % stepDays === 0).map((b) => b.date);

  const cards = [];
  const outcomes = [];
  const rows = [];
  const skipped = [];

  for (const d of dates) {
    const facts = sliceAsOf(bag, d, { years });
    if (!facts) {
      skipped.push({ date: d, reason: '切片为空' });
      continue;
    }
    let res;
    try {
      res = runPipeline(facts);
    } catch (e) {
      skipped.push({ date: d, reason: `流水线异常: ${e.message}` });
      continue;
    }
    if (!res.ok) {
      skipped.push({ date: d, reason: `校验失败: ${res.errors.slice(0, 2).join('; ')}` });
      continue;
    }

    const card = res.card;
    const realized = measureOutcome(bag.kline, d);

    cards.push(card);
    for (const h of HORIZONS) {
      const r = realized[h];
      outcomes.push({
        card_id: card.card_id,
        horizon: h,
        due_date: r?.end_date ?? null,
        realized: r ? { dir: r.dir, ret_pct: r.ret_pct, max_dd_pct: r.max_dd_pct } : null,
      });
    }

    rows.push({
      date: d,
      verdict: card.verdict,
      risk: card.risk?.level,
      dirs: Object.fromEntries(HORIZONS.map((h) => [h, card.horizons?.[h]?.dir])),
      probs: Object.fromEntries(HORIZONS.map((h) => [h, card.horizons?.[h]?.prob_up])),
      actual: Object.fromEntries(HORIZONS.map((h) => [h, realized[h]?.ret_pct ?? null])),
      actual_dir: Object.fromEntries(HORIZONS.map((h) => [h, realized[h]?.dir ?? null])),
    });
  }

  const stats = scoreOutcomes(cards, outcomes);
  const coverage = coverageStats(rows);
  return { code: norm(code), name: bag.name, bag, cards, outcomes, rows, skipped, stats, coverage, params: { start, end, stepDays, years } };
}

/**
 * 覆盖率感知的准确率。
 * 「震荡」占 96% 的系统命中率再高也没有价值 —— 必须区分「有观点时的准确率」和「敢不敢有观点」。
 */
export function coverageStats(rows) {
  const out = {};
  for (const h of HORIZONS) {
    const valid = rows.filter((r) => r.actual_dir[h] !== null && r.dirs[h] !== 'unknown');
    const calls = valid.filter((r) => r.dirs[h] !== 'flat');
    const hit = calls.filter((r) => r.dirs[h] === r.actual_dir[h]).length;
    const upCalls = calls.filter((r) => r.dirs[h] === 'up');
    const downCalls = calls.filter((r) => r.dirs[h] === 'down');
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    // 朴素基准：全押上涨 / 全押下跌 / 多数类
    const actualUp = valid.filter((r) => r.actual_dir[h] === 'up').length;
    const actualDown = valid.filter((r) => r.actual_dir[h] === 'down').length;
    out[h] = {
      n_evaluable: valid.length,
      n_calls: calls.length,
      coverage: valid.length ? calls.length / valid.length : null,
      hit_rate_calls: calls.length ? hit / calls.length : null,
      n_up_calls: upCalls.length,
      hit_up: upCalls.length ? upCalls.filter((r) => r.dirs[h] === 'up' && r.actual_dir[h] === 'up').length / upCalls.length : null,
      n_down_calls: downCalls.length,
      hit_down: downCalls.length ? downCalls.filter((r) => r.dirs[h] === 'down' && r.actual_dir[h] === 'down').length / downCalls.length : null,
      avg_ret: avg(valid.map((r) => r.actual[h])),
      avg_ret_when_up_call: avg(upCalls.map((r) => r.actual[h])),
      avg_ret_when_down_call: avg(downCalls.map((r) => r.actual[h])),
      avg_ret_when_flat_call: avg(valid.filter((r) => r.dirs[h] === 'flat').map((r) => r.actual[h])),
      naive_always_up: valid.length ? actualUp / valid.length : null,
      naive_majority: valid.length ? Math.max(actualUp, actualDown, valid.length - actualUp - actualDown) / valid.length : null,
    };
  }
  return out;
}

/** 把回测结果渲染成 Markdown（给人看的证明） */
export function renderBacktest(bt) {
  const L = [];
  const s = bt.stats;
  L.push(`# 天市 · 回测证明 — ${bt.name ?? ''} (${bt.code})`);
  L.push('');
  L.push(`> 区间 ${bt.params.start} ~ ${bt.params.end} ｜ 每 ${bt.params.stepDays} 个交易日抽样 ｜ 有效卡片 ${bt.cards.length} 张 ｜ 跳过 ${bt.skipped.length} 张`);
  L.push('> 所有卡片只使用 asof 之前的数据生成，打分使用 asof 之后的真实走势。');
  L.push('');

  const c = bt.coverage ?? {};
  const NAME = { short: '短线 5 日', mid: '中线 60 日', long: '长线 250 日' };
  const p = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);

  L.push('## 敢不敢有观点 + 有观点时准不准');
  L.push('');
  L.push('> 「命中率」只统计**非震荡**的方向判断。把震荡算进命中率会让一个从不表态的系统看起来还行。');
  L.push('');
  L.push('| 周期 | 可评估 | 有观点 | 覆盖率 | 方向命中 | 看多命中 | 看空命中 | 朴素基准(多数类) |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const h of HORIZONS) {
    const v = c[h] ?? {};
    L.push(
      `| ${NAME[h]} | ${v.n_evaluable ?? 0} | ${v.n_calls ?? 0} | ${p(v.coverage)} | ${p(v.hit_rate_calls)} | ${p(v.hit_up)} (${v.n_up_calls ?? 0}) | ${p(v.hit_down)} (${v.n_down_calls ?? 0}) | ${p(v.naive_majority)} |`,
    );
  }
  L.push('');

  L.push('## 不同表态下的实际收益');
  L.push('');
  L.push('| 周期 | 看多时平均收益 | 看空时平均收益 | 震荡时平均收益 | 全样本平均 |');
  L.push('|---|---|---|---|---|');
  for (const h of HORIZONS) {
    const v = c[h] ?? {};
    const f = (x) => (x === null || x === undefined ? '—' : `${x.toFixed(2)}%`);
    L.push(`| ${NAME[h]} | ${f(v.avg_ret_when_up_call)} | ${f(v.avg_ret_when_down_call)} | ${f(v.avg_ret_when_flat_call)} | ${f(v.avg_ret)} |`);
  }
  L.push('');
  L.push('> 检验信息量：看多时的平均收益应显著高于看空时。若两者接近，说明方向判断没有区分度。');
  L.push('');

  L.push('## 概率校准（说 X% 的时候真的兑现了多少）');
  L.push('');
  L.push('| 预测概率区间 | 样本数 | 平均预测 | 实际上涨频率 | 偏差 |');
  L.push('|---|---|---|---|---|');
  for (const b of s.calibration ?? []) {
    const gap = b.predicted === null || b.actual === null ? '—' : `${((b.actual - b.predicted) * 100).toFixed(1)}%`;
    L.push(`| ${b.bucket}% | ${b.n} | ${b.predicted === null ? '—' : (b.predicted * 100).toFixed(1) + '%'} | ${b.actual === null ? '—' : (b.actual * 100).toFixed(1) + '%'} | ${gap} |`);
  }
  L.push('');
  L.push('> 校准良好的系统，偏差应接近 0；系统性高估（偏差为负）说明过于自信。');
  L.push('');

  L.push('## 风险等级 vs 实际最大回撤');
  L.push('');
  L.push('| 风险等级 | 样本数 | 回撤中位数 |');
  L.push('|---|---|---|');
  for (const r of s.risk_vs_drawdown ?? []) {
    L.push(`| R${r.level} | ${r.n} | ${r.median_max_dd === null ? '—' : r.median_max_dd.toFixed(2) + '%'} |`);
  }
  L.push('');
  L.push('> 若 R1 的回撤中位数不比 R4 小，说明风险分级没有区分度。');
  L.push('');

  L.push('## 五道闸调用统计');
  L.push('');
  L.push('| 闸 | pass | warn | fail |');
  L.push('|---|---|---|---|');
  for (const g of s.gate_fail_stats ?? []) L.push(`| ${g.gate} | ${g.pass} | ${g.warn} | ${g.fail} |`);
  L.push('');

  if (bt.skipped.length) {
    L.push('## 被跳过的日期（校验未通过）');
    L.push('');
    for (const k of bt.skipped.slice(0, 10)) L.push(`- ${k.date}：${k.reason}`);
    if (bt.skipped.length > 10) L.push(`- …共 ${bt.skipped.length} 条`);
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('**这是对方法本身的检验，不是收益率曲线。** 回测通过只说明判断有信息量，不说明能赚钱：交易成本、滑点、涨跌停无法成交都没建模。');
  return L.join('\n');
}
