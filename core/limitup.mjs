/**
 * 涨停归因 + 同题材弹性标的
 *
 * 原则：
 *   1. 涨停原因只用**可核实的证据**（封板时间、封单额、板块涨停家数、新闻命中、龙虎榜），
 *      不做「大概率是某某游资」这种无法验证的猜测。
 *   2. 证据不足时明确写「原因不明」，不编故事。
 *   3. 弹性候选只是「同题材里波动更大、更可能跟着动」的标的，不是推荐买入。
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

async function getJson(url, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

/** 市场板块归属：决定涨跌幅限制与弹性 */
export function marketOf(code) {
  const c = String(code ?? '');
  if (/^(83|87|88|92|43|82)/.test(c)) return { key: 'bse', name: '北交所', limit_pct: 30 };
  if (/^68/.test(c)) return { key: 'star', name: '科创板', limit_pct: 20 };
  if (/^30/.test(c)) return { key: 'chinext', name: '创业板', limit_pct: 20 };
  return { key: 'main', name: '主板', limit_pct: 10 };
}

/** 板块成分股（含涨跌幅、流通市值、换手） */
export async function fetchSectorMembers(sectorCode, size = 100) {
  if (!sectorCode) return [];
  try {
    const j = await getJson(
      `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${size}&po=1&np=1&fltt=2&invt=2&fid=f3` +
      `&fs=b:${encodeURIComponent(sectorCode)}&fields=f2,f3,f6,f8,f12,f14,f20,f21`,
    );
    const rows = j?.data?.diff ?? [];
    return rows.map((x) => ({
      code: String(x.f12 ?? ''),
      name: x.f14 ?? '',
      pct: isNum(x.f3) ? x.f3 : null,
      price: isNum(x.f2) ? x.f2 : null,
      amount: isNum(x.f6) ? x.f6 : null,
      turnover: isNum(x.f8) ? x.f8 : null,
      float_cap: isNum(x.f21) ? x.f21 : null,
    })).filter((x) => x.code && x.name);
  } catch {
    return [];
  }
}

/** 涨停强度 */
export function judgeStrength(pool) {
  if (!pool) return null;
  const lbc = Number(pool.lbc) || 0;
  const fbt = Number(pool.fbt) || null;          // 92500 = 09:25:00
  const fund = Number(pool.fund) || 0;           // 封单额
  const zbc = Number(pool.zbc) || 0;             // 炸板次数
  const ltsz = Number(pool.ltsz) || 0;           // 流通市值

  const evidence = [];
  let score = 0;

  // 连板高度
  if (lbc >= 5) { score += 40; evidence.push(`已 ${lbc} 连板，是当前空间板梯队`); }
  else if (lbc >= 3) { score += 30; evidence.push(`已 ${lbc} 连板`); }
  else if (lbc === 2) { score += 20; evidence.push('2 连板'); }
  else { score += 10; evidence.push('首板'); }

  // 封板时间
  if (fbt !== null) {
    const hh = Math.floor(fbt / 10000);
    const mm = Math.floor((fbt % 10000) / 100);
    const t = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    if (fbt <= 93000) { score += 22; evidence.push(`${t} 封板（开盘即封，最强）`); }
    else if (fbt <= 103000) { score += 14; evidence.push(`${t} 封板（早盘封板）`); }
    else if (fbt <= 143000) { score += 6; evidence.push(`${t} 封板`); }
    else { score += 2; evidence.push(`${t} 尾盘封板（最弱）`); }
  }

  // 封单额 / 流通市值
  if (fund > 0 && ltsz > 0) {
    const ratio = (fund / ltsz) * 100;
    if (ratio >= 5) { score += 22; evidence.push(`封单 ${(fund / 1e8).toFixed(2)} 亿，占流通市值 ${ratio.toFixed(1)}%（封得死）`); }
    else if (ratio >= 1) { score += 12; evidence.push(`封单 ${(fund / 1e8).toFixed(2)} 亿，占流通市值 ${ratio.toFixed(1)}%`); }
    else { score += 4; evidence.push(`封单 ${(fund / 1e8).toFixed(2)} 亿，占流通市值仅 ${ratio.toFixed(2)}%（封单薄）`); }
  }

  // 炸板
  if (zbc > 0) { score -= Math.min(20, zbc * 6); evidence.push(`盘中炸板 ${zbc} 次`); }

  score = Math.max(0, Math.min(100, score));
  const label = score >= 75 ? '强（封得死）' : score >= 55 ? '中上' : score >= 40 ? '一般' : '弱（易开板）';
  return { score, label, evidence, raw: { lbc, fbt, fund, zbc, ltsz } };
}

/**
 * 归因 + 弹性候选
 * @param {object} p { facts, pool, members, news, pct }
 */
export function analyzeLimitUp({ facts, pool, members, news, pct }) {
  const mkt = marketOf(facts?.symbol);
  const chg = isNum(pct) ? pct : (isNum(facts?.quote?.pct_chg) ? facts.quote.pct_chg : null);
  const isLimitUp = chg !== null && chg >= mkt.limit_pct - 0.5;
  if (!isLimitUp) return { is_limitup: false, market: mkt };

  const strength = pool ? judgeStrength(pool) : null;
  const causes = [];
  const caveats = [];

  /* ① 板块效应：同板块涨停家数 */
  const peers = (members ?? []).filter((x) => x.code !== String(facts.symbol));
  const lim = mkt.limit_pct;
  // 同板块里每只票的涨停幅度不同（主板 10%、双创 20%、北交所 30%），必须各按各的市场判断
  const isPeerLimit = (x) => {
    if (!isNum(x.pct)) return false;
    const mk = marketOf(x.code);
    return x.pct >= mk.limit_pct - 0.6;
  };
  const peerLimits = peers.filter(isPeerLimit);
  if (peerLimits.length >= 3) {
    causes.push({
      type: 'sector', title: `板块联动（同板块另有 ${peerLimits.length} 只涨停）`,
      evidence: peerLimits.slice(0, 6).map((x) => `${x.name}${x.pct > 0 ? ' +' + x.pct.toFixed(1) + '%' : ''}`).join('、'),
      weight: 'strong',
    });
  } else if (peerLimits.length > 0) {
    causes.push({
      type: 'sector_weak', title: `同板块有 ${peerLimits.length} 只涨停，板块效应偏弱`,
      evidence: peerLimits.map((x) => x.name).join('、'), weight: 'weak',
    });
  }

  /* ② 消息/政策（必须与本公司或本行业相关，否则不算原因） */
  const sectorName = String(facts.sector?.name ?? '').replace(/[ⅠⅡⅢ]/g, '');
  const name = String(facts.name ?? '');
  const relevant = (item) => {
    const t = String(item?.title ?? '');
    if (name && t.includes(name)) return true;
    if (sectorName && t.includes(sectorName)) return true;
    // 行业关键词命中（如 铝、有色、铜）
    const kws = sectorName ? [sectorName.slice(0, 2)] : [];
    return kws.some((k) => k && t.includes(k));
  };
  if (news?.ok) {
    const pol = (news.policy_news ?? []).filter(relevant).slice(0, 3);
    if (pol.length) {
      causes.push({
        type: 'policy', title: '检索到政策相关新闻',
        evidence: pol.map((x) => `${x.date?.slice(0, 10)} ${x.title}`).join('；'),
        weight: 'medium',
      });
    }
    const co = (news.company_news ?? []).filter(relevant).slice(0, 3);
    if (co.length) {
      causes.push({
        type: 'news', title: '公司层面近期新闻',
        evidence: co.map((x) => `${x.date?.slice(0, 10)} ${x.title}`).join('；'),
        weight: 'weak',
      });
    }
  }

  /* ③ 封板结构本身就是最强证据 */
  if (strength) {
    causes.push({
      type: 'strength', title: `封板强度：${strength.label}`,
      evidence: strength.evidence.join('；'), weight: strength.score >= 70 ? 'strong' : 'medium',
    });
  }

  if (!causes.length) caveats.push('没有找到可核实的涨停原因（板块无联动、无政策/新闻命中、无封板数据）');

  /* ④ 弹性候选：同板块分市场分层 */
  const byMarket = { bse: [], star: [], chinext: [], main: [] };
  for (const x of peers) {
    if (!isNum(x.pct)) continue;
    if (x.pct >= lim - 0.6) continue; // 已涨停的不作为弹性候选
    const mk = marketOf(x.code);
    byMarket[mk.key].push({
      code: x.code, name: x.name, pct: Number(x.pct.toFixed(2)),
      float_cap_yi: x.float_cap ? Number((x.float_cap / 1e8).toFixed(1)) : null,
      turnover: x.turnover === null ? null : Number(x.turnover.toFixed(1)),
      limit_pct: mk.limit_pct,
      market: mk.name,
    });
  }
  // 排序：涨跌幅靠前 + 流通市值小 + 换手活跃
  for (const k of Object.keys(byMarket)) {
    byMarket[k] = byMarket[k]
      .sort((a, b) => (b.pct - a.pct) || ((a.float_cap_yi ?? 1e9) - (b.float_cap_yi ?? 1e9)))
      .slice(0, 6);
  }

  const tiers = [
    { key: 'bse', name: '北交所', note: '30% 涨跌幅，弹性最大，但流动性最差、滑点最大', items: byMarket.bse },
    { key: 'star', name: '科创板', note: '20% 涨跌幅，弹性大，需 50 万门槛', items: byMarket.star },
    { key: 'chinext', name: '创业板', note: '20% 涨跌幅，弹性大', items: byMarket.chinext },
    { key: 'main', name: '主板', note: '10% 涨跌幅，弹性最小但流动性最好', items: byMarket.main },
  ].filter((t) => t.items.length);

  caveats.push('弹性大＝波动大。这些标的只是同题材里弹性更强的，不代表会跟涨，也不构成推荐');

  return {
    is_limitup: true,
    market: mkt,
    pct: chg,
    strength,
    causes,
    tiers,
    caveats,
  };
}
