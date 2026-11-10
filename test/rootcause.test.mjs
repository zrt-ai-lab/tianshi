/**
 * 根因链路与产业链本体的回归测试
 * 锁住的都是实测中发现过的问题：拆股跳点、美股时差对齐、行业优先匹配、大盘基准选择。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toReturns, alignLagged, regress, analyzeRootCause, marketIndexFor } from '../core/rootcause.mjs';
import { matchOntology } from '../core/ontology.mjs';

function series(dates, rets, start = 100) {
  const out = [{ date: dates[0], close: start }];
  let p = start;
  for (let i = 1; i < dates.length; i++) { p = p * (1 + rets[i] / 100); out.push({ date: dates[i], close: p }); }
  return out;
}
function days(n, from = '2026-01-01') {
  const out = []; const d = new Date(from + 'T00:00:00Z');
  while (out.length < n) { const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
// 可复现的伪随机
function rng(seed) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; }; }

test('单日涨跌超 40% 视为拆股等公司行为并剔除（实测 SOXX 450→131）', () => {
  const { rets, dropped } = toReturns([
    { date: 'd1', close: 450 }, { date: 'd2', close: 455 }, { date: 'd3', close: 131.9 }, { date: 'd4', close: 136.5 },
  ]);
  assert.deepEqual(dropped, ['d3']);
  assert.ok(!rets.has('d3'));
  assert.ok(rets.has('d2') && rets.has('d4'));
});

test('海外对齐：A 股 D 日对应美股 D 之前最近一个交易日', () => {
  const us = new Map([['2026-11-05', 1], ['2026-11-06', 2]]);
  const al = alignLagged(['2026-11-06', '2026-11-09'], us);
  assert.equal(al.get('2026-11-06').date, '2026-11-05'); // 同日美股尚未开盘
  assert.equal(al.get('2026-11-09').date, '2026-11-06'); // 周一 A 股 ← 上周五美股
});

test('回归斜率与相关系数', () => {
  const x = Array.from({ length: 50 }, (_, i) => Math.sin(i));
  const r = regress(x.map((v) => 2 * v + 1), x);
  assert.ok(Math.abs(r.beta - 2) < 1e-9);
  assert.ok(Math.abs(r.r - 1) < 1e-9);
});

test('归因：大盘 + 板块 + 个股 三部分之和等于实际涨跌，β 能被还原', () => {
  const ds = days(140);
  const rnd = rng(7);
  const m = ds.map(() => rnd() * 3);
  const sx = ds.map(() => rnd() * 2);            // 板块超额
  const b = m.map((v, i) => 1.0 * v + sx[i]);     // 板块 = 大盘 + 超额
  const s = m.map((v, i) => 1.2 * v + 0.8 * sx[i] + rnd() * 0.4); // 个股
  const rc = analyzeRootCause({
    stockBars: series(ds, s), marketBars: series(ds, m), sectorBars: series(ds, b), drivers: [],
  });
  assert.ok(rc.ok);
  assert.ok(Math.abs(rc.links.market.beta - 1.2) < 0.15, `大盘 β ${rc.links.market.beta}`);
  assert.ok(Math.abs(rc.links.sector.beta - 0.8) < 0.15, `板块 β ${rc.links.sector.beta}`);
  for (const k of ['today', 'd5', 'd20']) {
    const x = rc.decomposition[k];
    assert.ok(Math.abs(x.market + x.sector + x.own - x.total) < 0.05, `${k} 分解不闭合`);
  }
  assert.ok(rc.fit_r2 > 0.8);
});

test('与个股无关的海外标的不得进入解释篮子', () => {
  const ds = days(140);
  const rnd = rng(11);
  const m = ds.map(() => rnd() * 3);
  const s = m.map((v) => v + rnd());
  const noise = ds.map(() => rnd() * 4);
  const rc = analyzeRootCause({
    stockBars: series(ds, s), marketBars: series(ds, m), sectorBars: series(ds, m),
    drivers: [{ key: 'X', name: '无关标的', bars: series(ds, noise) }],
  });
  const d = rc.links.overseas.drivers.find((x) => x.key === 'X');
  assert.equal(d.significant, false);
  assert.deepEqual(rc.links.overseas.basket, []);
});

test('共同交易日不足时明确返回原因，不硬算', () => {
  const ds = days(10);
  const rc = analyzeRootCause({ stockBars: series(ds, ds.map(() => 1)), marketBars: series(ds, ds.map(() => 1)), sectorBars: [] });
  assert.equal(rc.ok, false);
  assert.match(rc.reason, /共同交易日不足/);
});

test('本体：行业优先——工业金属归入铜铝，不被「AI」等概念带偏', () => {
  const r = matchOntology('工业金属', ['AI眼镜', '人形机器人', '光伏设备', '储能']);
  assert.equal(r.nodes[0].key, 'copper');
  assert.ok(!r.nodes.some((n) => ['ai_compute', 'ev_robot', 'solar'].includes(n.key)));
});

test('本体：电力是国内驱动，不因「储能」概念被归到锂电', () => {
  const r = matchOntology('电力', ['储能', '电池']);
  assert.equal(r.nodes.length, 0);
  assert.ok(r.domestic);
});

test('本体：行业只写「半导体」时，用概念细化到晶圆代工', () => {
  const r = matchOntology('半导体', ['中芯概念', '国产芯片']);
  assert.equal(r.nodes[0].key, 'semi_mfg');
  assert.ok(!r.nodes.some((n) => n.key === 'semi_design'));
});

test('大盘基准统一用沪深300（科创50 行业集中，会吸收板块效应）', () => {
  for (const c of ['688981', '300750', '600900', '002578']) assert.equal(marketIndexFor(c).name, '沪深300');
});
