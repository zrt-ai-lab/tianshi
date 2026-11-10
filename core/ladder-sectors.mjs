/** Sector ladder conditions, not next-day probabilities. Exact industry matches only. */
const numeric = x => typeof x === 'number' && Number.isFinite(x);
const normalize = name => String(name || '').replace(/[ⅠⅡⅢ]$/u, '').trim();
export function buildSectorLadders(pool, previous, rotation, { previousAvailable = true } = {}) {
  const groups = new Map();
  for (const s of pool) {
    const name = s.industry || '行业未识别';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(s);
  }
  return [...groups].map(([industry, stocks]) => {
    const before = previous.filter(s => s.industry === industry);
    const max = Math.max(1, ...stocks.map(s => s.boards || 1));
    const levels = Array.from({ length: Math.max(7, max) }, (_, i) => ({ boards: i + 1, stocks: stocks.filter(s => (s.boards || 1) === i + 1) }));
    const promotion = [...new Set(before.map(s => s.boards || 1))].sort((a,b) => a-b).map(n => {
      const candidates = before.filter(s => (s.boards || 1) === n);
      const advanced = candidates.filter(s => stocks.some(t => t.code === s.code && t.boards === n + 1));
      return { from: n, to: n + 1, base: candidates.length, advanced: advanced.length, rate: previousAvailable ? Number((advanced.length / candidates.length * 100).toFixed(1)) : null };
    });
    const board = rotation?.boards?.find(b => b.kind === 'industry' && normalize(b.name) === normalize(industry)) || null;
    const median5 = rotation?.industry?.medians?.r5;
    const median60 = rotation?.industry?.medians?.r60;
    let cycle = '未匹配轮动数据';
    if (board && numeric(board.r5) && numeric(board.r60) && numeric(median5) && numeric(median60)) {
      const x5 = board.r5 - median5, x60 = board.r60 - median60;
      cycle = x60 >= 8 && x5 >= 0 ? '持续强势' : x60 >= 8 && x5 <= -2 ? '高位回落' : x60 <= -8 && x5 >= 2 ? '超跌反弹' : x60 <= -8 && x5 <= 0 ? '持续弱势' : '轮动过渡';
    }
    const reasons = [], risks = [];
    reasons.push('涨停池内 ' + stocks.length + ' 只，最高 ' + max + ' 板');
    const broken = stocks.filter(s => numeric(s.broken) && s.broken > 0).length;
    const early = stocks.filter(s => numeric(s.first_seal) && s.first_seal <= 103000).length;
    reasons.push('早盘首封 ' + early + ' 只；有开板记录 ' + broken + ' 只');
    const gap = levels.slice(0,max).filter(l => l.stocks.length === 0).map(l => l.boards);
    if (gap.length) risks.push('中间缺 ' + gap.join('/') + ' 板，接力梯队不完整');
    if (stocks.length === 1) risks.push('只有一只涨停，暂不能认定板块扩散');
    if (broken) risks.push('开板记录仅覆盖当前仍在涨停池的股票，不是全板块炸板率');
    if (board) {
      if (numeric(board.main1)) (board.main1 >= 0 ? reasons : risks).push('行业当日主力净额 ' + (board.main1 / 1e8).toFixed(2) + ' 亿（按成交金额分档估算）');
      if (cycle === '超跌反弹') risks.push('处于超跌反弹，尚不能据此认定趋势反转');
      if (cycle === '高位回落' || cycle === '持续弱势') risks.push('所属行业处于' + cycle);
    } else risks.push('行业与轮动未精确匹配，不用相似名称硬套');
    const broad = stocks.length >= 3 && max >= 2;
    const supportive = broad && !gap.length && board && board.main1 > 0 && (cycle === '持续强势' || cycle === '超跌反弹');
    const tier = supportive ? '接力条件相对齐全' : broad ? '已有热度，仍需确认' : '局部活跃，接力证据不足';
    return { industry, count: stocks.length, max_boards: max, levels, promotion, rotation: board, cycle, tier, reasons, risks, probability: null };
  }).sort((a,b) => b.count-a.count || b.max_boards-a.max_boards);
}
