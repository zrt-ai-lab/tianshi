/**
 * 跨年妖规则回归测试：锁住依据网评共识做的修正
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { crossYearEligibility, CROSS_YEAR_RULES } from '../core/monster.mjs';

const base = {
  price: 6, float_cap_yi: 25, pos120: 30, max_consecutive_90d: 3, limit_ups_90d: 5, ret30: 40,
  limit_down_5d: 0, from_high: -5,
  launch: { date: '2026-11-18', price: 5.2, pos_before: 22, gain_since: 30 },
};
const hot = { hot_concepts: ['人工智能', '机器人概念'] };
const extra = { org_ratio: 2, org_date: '2026-09-30', catalysts: [] };

test('不在 11 月—次年 1 月窗口直接返回不评估', () => {
  const r = crossYearEligibility(base, hot, false, extra);
  assert.equal(r.eligible, false);
  assert.match(r.note, /不在跨年窗口/);
});

test('典型画像（低价小盘热门题材、11 月中旬启动、连板）应入选且高分', () => {
  const r = crossYearEligibility(base, hot, true, extra);
  assert.equal(r.eligible, true);
  assert.ok(r.score >= 75, `相似度 ${r.score}`);
});

test('估值不再是加分项：亏损（PE 为负）不影响结果', () => {
  const a = crossYearEligibility({ ...base, pe: -50 }, hot, true, extra);
  const b = crossYearEligibility({ ...base, pe: 12 }, hot, true, extra);
  assert.equal(a.score, b.score);
  assert.ok(!a.checks.some((c) => c.key === '估值'));
});

test('股价标准收紧到 10 元：15 元不再算低价（旧规则 17 元会通过）', () => {
  const r = crossYearEligibility({ ...base, price: 15, launch: { ...base.launch, price: 15 } }, hot, true, extra);
  assert.equal(r.checks.find((c) => c.key === '低价').pass, false);
  assert.equal(r.eligible, false, '低价是核心特征，缺失不应入选');
});

test('启动时间：9 月启动的不算跨年窗口启动', () => {
  const r = crossYearEligibility({ ...base, launch: { ...base.launch, date: '2026-09-11' } }, hot, true, extra);
  assert.equal(r.checks.find((c) => c.key === '启动时间').pass, false);
});

test('三项核心特征缺一不可：没有热门题材即使其他都满足也不入选', () => {
  const r = crossYearEligibility(base, { hot_concepts: [] }, true, extra);
  assert.equal(r.eligible, false);
  assert.match(r.note, /核心特征不全/);
});

test('机构持股缺数据时不计分也不罚分（不进分母）', () => {
  const r = crossYearEligibility(base, hot, true, { org_ratio: null, catalysts: [] });
  const c = r.checks.find((x) => x.key === '筹码干净');
  assert.equal(c.pass, null);
  assert.ok(r.score >= 75);
});

test('风险项：30 日涨幅接近监管红线、近期跌停都要提示', () => {
  const r = crossYearEligibility({ ...base, ret30: 180, limit_down_5d: 1 }, hot, true, extra);
  assert.ok(r.risks.some((t) => t.includes('监管红线')));
  assert.ok(r.risks.some((t) => t.includes('跌停')));
});

test('规则权重合计 100，并记录来源', () => {
  const sum = CROSS_YEAR_RULES.core.reduce((a, r) => a + r.weight, 0);
  assert.equal(sum, 100);
  assert.ok(CROSS_YEAR_RULES.sources.articles >= 40);
});
