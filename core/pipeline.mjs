/**
 * 天市 · 统一流水线
 *
 * 实时体检（cli card）与历史回测（cli backtest）必须走**同一条路径**，
 * 否则「回测通过」不能证明「线上可信」。这个模块就是那条路径。
 *
 * facts → 分析 → 五道闸 → 玉衡 → 七政卡 → 双层校验 → 返回
 */

import { baselineAnalysis, deriveCounterEvidence, decideVerdict, buildBuyConditions } from './analysis.mjs';
import { DIRECTIONAL, RISK_GRADING } from './validation.mjs';
import { runGates } from './contract/gates.mjs';
import { computeRisk } from './contract/yuzheng.mjs';
import { buildCard, validateCard } from './contract/qizheng.mjs';
import { checkEvidenceChain } from './provenance.mjs';

/**
 * @param {object} facts CONTRACT.md §2 的事实包
 * @returns {{ok:boolean, card:object|null, gates:object, risk:object, analysis:object, errors:string[], chain:object}}
 */
export function runPipeline(facts) {
  const analysis = baselineAnalysis(facts);
  const counter = deriveCounterEvidence(facts);

  const gates = runGates(facts, {
    counter_evidence: counter,
    sample_n: analysis.horizons.short?.sample_n ?? 0,
  });

  const risk = computeRisk(facts, gates);

  analysis.verdict = decideVerdict(facts, gates, risk);
  analysis.sample_n = analysis.horizons.short?.sample_n ?? 0;
  // 回放时卡片身份必须锚在「回放时点」，否则所有历史卡都会拿到同一个 card_id，
  // 账本/校准按 card_id 去重后就只剩一张（这个坑很隐蔽，靠回测样本数才暴露）。
  if (facts.replay?.asof) analysis.as_of = `${facts.replay.asof}T15:00:00+08:00`;

  const card = buildCard(facts, gates, risk, analysis);
  if (!card.counter_evidence?.length) card.counter_evidence = counter;

  // 证据清单：把关键事实块挂到卡面（校验要求它们都能落回 facts.evidence）
  if (!card.evidence?.length) {
    const idx = new Map((facts.evidence ?? []).map((e) => [e.evidence_id, e]));
    const picked = [];
    for (const [key, label] of [
      ['quote', '实时快照'],
      ['fund_flow', '资金流'],
      ['financials', '财务'],
      ['valuation_pct', '估值分位'],
      ['sector', '行业板块'],
    ]) {
      const f = facts[key];
      if (f?.evidence_id && idx.has(f.evidence_id)) {
        picked.push({
          evidence_id: f.evidence_id,
          claim: f.replayed ? `${label}（回放）` : label,
          value: key,
          source: idx.get(f.evidence_id).source,
          as_of: facts.trade_date,
        });
      }
    }
    card.evidence = picked;
  }

  // 概率按最终置信上限收敛（全卡样本闸可能严于单周期）
  for (const k of ['short', 'mid', 'long']) {
    const h = card.horizons?.[k];
    if (!h) continue;
    h.sample_n = analysis.horizons?.[k]?.sample_n ?? null;
    h.sample_n_raw = analysis.horizons?.[k]?.sample_n_raw ?? null;
    if (h.prob_up !== null && typeof h.confidence_cap === 'number' && h.prob_up > h.confidence_cap) {
      h.prob_up = Number(h.confidence_cap.toFixed(3));
      h.drivers = Array.isArray(h.drivers) ? h.drivers : [];
      h.drivers.push(`把握度按闸门上限收敛到 ${(h.confidence_cap * 100).toFixed(0)}%`);
    }
  }

  // 附上实证验证状态：让任何消费方（人 / 模型 / 下游系统）都知道哪些能信
  card.validation = {
    directional: { status: DIRECTIONAL.status, claim: DIRECTIONAL.claim, by_horizon: DIRECTIONAL.by_horizon, note: DIRECTIONAL.note },
    risk_grading: { status: RISK_GRADING.status, claim: RISK_GRADING.claim, by_level: RISK_GRADING.by_level, note: RISK_GRADING.note },
  };
  card.buy_conditions = buildBuyConditions(facts, risk);
  for (const k of ['short', 'mid', 'long']) {
    if (card.horizons?.[k]) card.horizons[k].validated = false; // 方向未通过样本外验证
  }

  const structural = validateCard(card, facts);
  const chain = checkEvidenceChain(card, facts);
  const errors = [...structural.errors, ...chain.errors];

  return { ok: errors.length === 0, card, gates, risk, analysis, errors, chain };
}
