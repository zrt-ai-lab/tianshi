/**
 * 天市 · 东方财富数据源
 *
 * 用途：日K、资金流、财务、估值历史、板块、龙虎榜、公告。
 * 与腾讯快照互为「双源交叉」，关键字段不一致会写进 facts.conflicts。
 *
 * 所有函数都返回 { data, evidence }，data 取不到时为 null，
 * evidence.ok=false 并写明原因 —— 绝不返回伪造数据。
 */

import { fetchRaw, decode, tryJson, num } from '../http.mjs';
import { makeEvidence, saveRaw, evidenceId, nowShanghai, compactDate } from '../provenance.mjs';

const SOURCE = 'eastmoney';
const SOURCE_DC = 'eastmoney-datacenter';
const UA_UT = 'b2884a393a59ad64002292a3e90d46a5'; // 公开页使用的 ut 参数

/**
 * 600519 -> 1.600519
 * 沪市（6xxxxx、科创 688/689、沪 B 股 900）= 1
 * 深市（000/001/002/003/300/301、深 B 股 200）= 0
 * 北交所（4xxxxx、8xxxxx、920xxx）= 0  ← 注意：920 属北交所，不是沪市
 */
export function secid(code) {
  const c = String(code).replace(/^(sh|sz|bj)/i, '');
  if (/^6/.test(c) || /^900/.test(c)) return `1.${c}`;
  return `0.${c}`;
}

async function grab({ url, source, kind, code, rootDir, now, encoding = 'utf-8', parse }) {
  const eid = evidenceId(code, source, kind, now);
  const r = await fetchRaw(url, { headers: { Referer: 'https://data.eastmoney.com/' } });
  const relPath = `evidence/${compactDate(now)}/${code}/${source}_${kind}.json`;
  const saved = r.buf.length ? saveRaw(r.buf, relPath, rootDir) : { raw_path: relPath, raw_sha256: '' };

  const evidence = makeEvidence({
    evidence_id: eid,
    source,
    endpoint: url,
    fetched_at: nowShanghai(now),
    raw_sha256: saved.raw_sha256,
    raw_path: saved.raw_path,
    encoding,
    ok: r.ok && r.buf.length > 0,
    error: r.error,
  });

  if (!evidence.ok) return { data: null, evidence };

  const json = tryJson(decode(r.buf, encoding));
  if (json === null) return { data: null, evidence: { ...evidence, ok: false, error: 'invalid json' } };

  const out = parse(json);
  if (out === null) return { data: null, evidence: { ...evidence, ok: false, error: 'parse failed or empty' } };
  return { data: out, evidence };
}

/* ── 实时快照（第二路，用于交叉验证） ─────────────────────── */

export function fetchQuote(code, opts = {}) {
  const url =
    `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid(code)}` +
    `&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f168,f169,f170,f116,f117,f162,f167,f127,f128`;
  return grab({
    ...opts,
    url,
    source: SOURCE,
    kind: 'quote',
    code,
    parse: (j) => {
      const d = j?.data;
      if (!d) return null;
      return {
        name: d.f58 ?? null,
        price: num(d.f43) === null ? null : num(d.f43) / 100,
        high: num(d.f44) === null ? null : num(d.f44) / 100,
        low: num(d.f45) === null ? null : num(d.f45) / 100,
        open: num(d.f46) === null ? null : num(d.f46) / 100,
        prev_close: num(d.f60) === null ? null : num(d.f60) / 100,
        volume: num(d.f47) === null ? null : num(d.f47) * 100, // 手 -> 股（与腾讯源统一）
        amount: num(d.f48),
        turnover_rate: num(d.f168) === null ? null : num(d.f168) / 100,
        pct_chg: num(d.f170) === null ? null : num(d.f170) / 100,
        pe_ttm: num(d.f162) === null ? null : num(d.f162) / 100,
        pb: num(d.f167) === null ? null : num(d.f167) / 100,
        total_mv: num(d.f116),
        industry: d.f127 ?? null,
        region: d.f128 ?? null,
      };
    },
  });
}

/* ── 日K ─────────────────────────────────────────────────── */

/**
 * @param {string} code
 * @param {{klt?:number, fqt?:number, lmt?:number}} o
 *   klt: 101=日 102=周 103=月；fqt: 1=前复权 0=不复权 2=后复权
 */
export function fetchKline(code, o = {}) {
  const { klt = 101, fqt = 1, lmt = 250, asof = null } = o;
  const end = asof ? String(asof).replaceAll("-", "") : "20500101";
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid(code)}` +
    `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58` +
    `&klt=${klt}&fqt=${fqt}&end=${end}&lmt=${lmt}`;
  return grab({
    ...o,
    url,
    source: SOURCE,
    kind: `kline_${klt}_${fqt}`,
    code,
    parse: (j) => {
      const ks = j?.data?.klines;
      if (!Array.isArray(ks) || ks.length === 0) return null;
      return ks.map((line) => {
        const [date, open, close, high, low, volume, amount, amplitude] = line.split(',');
        return {
          date,
          open: num(open),
          close: num(close),
          high: num(high),
          low: num(low),
          volume: num(volume) === null ? null : num(volume) * 100, // 手 -> 股（与快照统一）
          amount: num(amount),
          amplitude: num(amplitude),
        };
      });
    },
  });
}

/* ── 主力资金流 ──────────────────────────────────────────── */

export async function fetchFundFlow(code, o = {}) {
  const { rootDir = '.', now = new Date(), asof = null } = o;
  const evidenceList = [];

  // ① 日频历史（push2his）——最后一天通常是「上一个已收盘交易日」
  const dailyUrl =
    `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=0&klt=101&secid=${secid(code)}` +
    `&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65`;
  // ② 当日盘中累计（push2）——盘中才有效，收盘后为全日
  const intradayUrl =
    `https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?lmt=0&klt=1&secid=${secid(code)}` +
    `&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65&ut=${UA_UT}`;

  const [dRes, iRes] = await Promise.all([
    fetchRaw(dailyUrl, { headers: { Referer: 'https://quote.eastmoney.com/' } }),
    fetchRaw(intradayUrl, { headers: { Referer: 'https://quote.eastmoney.com/' } }),
  ]);

  const save = (res, kind, url) => {
    const eid = evidenceId(code, SOURCE, kind, now);
    const relPath = `evidence/${compactDate(now)}/${code}/${SOURCE}_${kind}.json`;
    const saved = res.buf.length ? saveRaw(res.buf, relPath, rootDir) : { raw_path: relPath, raw_sha256: '' };
    const ev = makeEvidence({
      evidence_id: eid,
      source: SOURCE,
      endpoint: url,
      fetched_at: nowShanghai(now),
      raw_sha256: saved.raw_sha256,
      raw_path: saved.raw_path,
      ok: res.ok && res.buf.length > 0,
      error: res.error,
    });
    evidenceList.push(ev);
    return ev.ok ? tryJson(decode(res.buf)) : null;
  };

  const dJson = save(dRes, 'fundflow_daily', dailyUrl);
  const iJson = save(iRes, 'fundflow_intraday', intradayUrl);

  const dk = dJson?.data?.klines;
  if (!Array.isArray(dk) || dk.length === 0) return { data: null, evidence: evidenceList };

  let rows = dk.map((l) => {
    const p = l.split(',');
    return {
      date: p[0],
      main_net: num(p[1]),
      small_net: num(p[2]),
      medium_net: num(p[3]),
      large_net: num(p[4]),
      super_net: num(p[5]),
    };
  });
  if (asof) rows = rows.filter((r) => r.date <= asof);
  if (rows.length === 0) return { data: null, evidence: evidenceList };
  const last = rows.at(-1);
  const sumTail = (n) => {
    const tail = rows.slice(-n);
    return tail.some((r) => r.main_net !== null) ? tail.reduce((a, r) => a + (r.main_net ?? 0), 0) : null;
  };

  // 当日盘中累计：取分时序列最后一行
  let today = null;
  const ik = iJson?.data?.klines;
  if (!asof && Array.isArray(ik) && ik.length > 0) {
    const p = ik.at(-1).split(',');
    today = { date: p[0], main_net: num(p[1]), super_net: num(p[5]), small_net: num(p[2]) };
  }

  return {
    data: {
      // 口径必须写清楚：daily 字段是「最后一个已收盘交易日」，today 是「当日盘中累计」
      trade_date: last.date,
      main_net: last.main_net,
      small_net: last.small_net,
      medium_net: last.medium_net,
      large_net: last.large_net,
      super_net: last.super_net,
      main_net_5d: sumTail(5),
      main_net_20d: sumTail(20),
      today_date: today?.date ?? null,
      today_main_net: today?.main_net ?? null,
      history_days: rows.length,
      recent: rows.slice(-20),
      evidence_id: evidenceList[0].evidence_id,
      today_evidence_id: evidenceList[1]?.evidence_id ?? null,
    },
    evidence: evidenceList,
  };
}

/* ── 财务 ────────────────────────────────────────────────── */

export function fetchFinancials(code, o = {}) {
  const { asof = null } = o;
  const c = String(code).replace(/^(sh|sz|bj)/i, '');
  const suffix = /^6/.test(c) || /^900/.test(c) ? 'SH' : /^(0|3|2)/.test(c) ? 'SZ' : 'BJ';
  const filter = encodeURIComponent(`(SECUCODE="${c}.${suffix}")`);
  const url =
    `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA` +
    `&columns=ALL&filter=${filter}&pageNumber=1&pageSize=${asof ? 20 : 1}` +
    `&sortColumns=REPORT_DATE&sortTypes=-1&source=HSF10&client=PC`;
  return grab({
    ...o,
    url,
    source: SOURCE_DC,
    kind: 'financials',
    code,
    parse: (j) => {
      let list = j?.result?.data;
      if (!Array.isArray(list) || list.length === 0) return null;
      // 点时回放：只取「截止 asof 已披露」的最近一期
      if (asof) list = list.filter((x) => String(x.REPORT_DATE ?? '').slice(0, 10) <= asof);
      const d = list[0];
      if (!d) return null;
      // ROE 是「报告期累计值」，必须年化后才能跨报告期比较。
      // 否则三季报的 7% 会被误读成年化 7%（真实约 9.3%）。
      const roeReported = num(d.ROEJQ);
      const rname = d.REPORT_DATE_NAME ?? '';
      const factor = /一季/.test(rname) ? 4 : /中报|半年/.test(rname) ? 2 : /三季/.test(rname) ? 4 / 3 : 1;
      const roeAnnualized = roeReported === null ? null : Number((roeReported * factor).toFixed(2));
      return {
        report_date: (d.REPORT_DATE ?? '').slice(0, 10) || null,
        report_name: d.REPORT_DATE_NAME ?? null,
        eps: num(d.EPSJB),
        bps: num(d.BPS),
        roe: roeAnnualized,          // 年化，供阈值比较
        roe_reported: roeReported,   // 原始累计值，供审计
        roe_annualize_factor: factor,
        revenue_yoy: num(d.TOTALOPERATEREVETZ),
        netprofit_yoy: num(d.PARENTNETPROFITTZ),
        gross_margin: num(d.XSMLL),
        net_margin: num(d.XSJLL),
        debt_ratio: num(d.ZCFZL),
        ocf_per_share: num(d.MGJYXJJE),
        revenue: num(d.TOTALOPERATEREVE),
        netprofit: num(d.PARENTNETPROFIT),
      };
    },
  });
}

/* ── 估值历史（用于真实分位数，不是猜测） ─────────────────── */

/**
 * 取最近 N 年估值日频，计算当前 PE/PB 处于历史百分位。
 * @returns {{pe_ttm_pct, pb_pct, window_years, as_of, current_pe, current_pb, n}}
 */
export function fetchValuationPct(code, o = {}) {
  const { years = 3, asof = null } = o;
  const c = String(code).replace(/^(sh|sz|bj)/i, '');
  const pageSize = 1000;
  const filter = encodeURIComponent(`(SECURITY_CODE="${c}")`);
  const url =
    `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_VALUEANALYSIS_DET` +
    `&columns=ALL&filter=${filter}&pageNumber=1&pageSize=${pageSize}` +
    `&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB`;
  return grab({
    ...o,
    url,
    source: SOURCE_DC,
    kind: 'valuation',
    code,
    parse: (j) => {
      let rows = j?.result?.data;
      if (!Array.isArray(rows) || rows.length === 0) return null;
      // 点时回放：只保留 asof 当日及之前的记录，杜绝未来函数
      if (asof) rows = rows.filter((r) => String(r.TRADE_DATE ?? '').slice(0, 10) <= asof);
      if (rows.length === 0) return null;
      const need = Math.round(years * 250);
      const slice = rows.slice(0, Math.min(need, rows.length));
      const pes = slice.map((r) => num(r.PE_TTM)).filter((v) => v !== null && v > 0);
      const pbs = slice.map((r) => num(r.PB_MRQ)).filter((v) => v !== null && v > 0);
      const cur = rows[0];
      const curPe = num(cur.PE_TTM);
      const curPb = num(cur.PB_MRQ);
      const pct = (arr, v) => {
        if (v === null || arr.length < 30) return null;
        return Number(((arr.filter((x) => x <= v).length / arr.length) * 100).toFixed(1));
      };
      return {
        pe_ttm_pct: pct(pes, curPe),
        pb_pct: pct(pbs, curPb),
        current_pe: curPe,
        current_pb: curPb,
        window_years: years,
        as_of: (cur.TRADE_DATE ?? '').slice(0, 10) || null,
        n: pes.length,
        board_name: cur.BOARD_NAME ?? null,
      };
    },
  });
}

/* ── 板块（行业）─────────────────────────────────────────── */

/**
 * 用行业名在行业板块列表里定位，拿到板块涨跌、主力净流入、排名。
 * 板块共约 500 个，接口单页上限 100，必须翻页（这里 6 页足够）。
 * 匹配顺序：精确 → 去掉 Ⅱ/Ⅲ 后缀 → 双向包含。命中不到就返回 matched=false。
 * 返回 evidence 为数组（每页一条，均可校验）。
 */
export async function fetchSector(industryName, o = {}) {
  const { rootDir = '.', now = new Date(), code = 'market' } = o;
  const perPage = 100;
  const pages = 6;
  const evidenceList = [];
  const all = [];

  const reqs = [];
  for (let pn = 1; pn <= pages; pn++) {
    const url =
      `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=${perPage}&po=1&np=1&fltt=2&invt=2` +
      `&fid=f3&fs=m:90+t:2&fields=f12,f14,f3,f62,f184`;
    reqs.push({ pn, url });
  }

  const results = await Promise.all(
    reqs.map(async ({ pn, url }) => {
      const eid = evidenceId(code, SOURCE, `sector_p${pn}`, now);
      const r = await fetchRaw(url, { headers: { Referer: 'https://quote.eastmoney.com/' } });
      const relPath = `evidence/${compactDate(now)}/${code}/${SOURCE}_sector_p${pn}.json`;
      const saved = r.buf.length ? saveRaw(r.buf, relPath, rootDir) : { raw_path: relPath, raw_sha256: '' };
      const ev = makeEvidence({
        evidence_id: eid,
        source: SOURCE,
        endpoint: url,
        fetched_at: nowShanghai(now),
        raw_sha256: saved.raw_sha256,
        raw_path: saved.raw_path,
        ok: r.ok && r.buf.length > 0,
        error: r.error,
      });
      const json = ev.ok ? tryJson(decode(r.buf)) : null;
      const list = json?.data?.diff;
      return { ev, list: Array.isArray(list) ? list : [] };
    }),
  );

  for (const { ev, list } of results) {
    evidenceList.push(ev);
    all.push(...list);
  }

  if (all.length === 0) return { data: null, evidence: evidenceList };

  const norm = (s) => String(s ?? '').replace(/[ⅡⅢⅠ]$/u, '');
  const target = norm(industryName);
  let idx = all.findIndex((x) => x.f14 === industryName);
  if (idx < 0) idx = all.findIndex((x) => norm(x.f14) === target);
  if (idx < 0) idx = all.findIndex((x) => norm(x.f14).includes(target) || target.includes(norm(x.f14)));

  const hit = idx >= 0 ? all[idx] : null;
  const matchedPage = idx >= 0 ? Math.floor(idx / perPage) : -1;
  const citedEvidence = matchedPage >= 0 ? evidenceList[matchedPage]?.evidence_id ?? evidenceList[0].evidence_id : evidenceList[0].evidence_id;
  return {
    data: {
      matched: hit !== null,
      evidence_id: citedEvidence,
      code: hit?.f12 ?? null,
      name: hit?.f14 ?? industryName ?? null,
      pct_chg: num(hit?.f3),
      main_net: num(hit?.f62),
      main_net_ratio: num(hit?.f184),
      rank_of_total: hit ? idx + 1 : null,
      total: all.length,
      industry_query: industryName,
    },
    evidence: evidenceList,
  };
}

/* ── 龙虎榜 ──────────────────────────────────────────────── */

export function fetchBillboard(code, o = {}) {
  const { asof = null } = o;
  const c = String(code).replace(/^(sh|sz|bj)/i, '');
  const filter = encodeURIComponent(`(SECURITY_CODE="${c}")`);
  const url =
    `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW` +
    `&columns=ALL&pageNumber=1&pageSize=20&sortColumns=TRADE_DATE&sortTypes=-1` +
    `&source=WEB&client=WEB&filter=${filter}`;
  return grab({
    ...o,
    url,
    source: SOURCE_DC,
    kind: 'billboard',
    code,
    parse: (j) => {
      const rows = j?.result?.data;
      if (!Array.isArray(rows)) return null;
      const kept = asof ? rows.filter((r) => String(r.TRADE_DATE ?? '').slice(0, 10) <= asof) : rows;
      if (kept.length === 0) return []; // 明确：没有上榜记录
      return kept.map((r) => ({
        trade_date: (r.TRADE_DATE ?? '').slice(0, 10),
        reason: r.EXPLANATION ?? r.EXPLAIN ?? null,
        net_buy: num(r.BILLBOARD_NET_AMT),
        explanation: r.EXPLAIN ?? null,
      }));
    },
  });
}

/* ── 公告 ────────────────────────────────────────────────── */

export function fetchAnnouncements(code, o = {}) {
  const { asof = null } = o;
  const c = String(code).replace(/^(sh|sz|bj)/i, '');
  const url =
    `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=10&page_index=1` +
    `&ann_type=A&client_source=web&stock_list=${c}`;
  return grab({
    ...o,
    url,
    source: SOURCE,
    kind: 'announcements',
    code,
    parse: (j) => {
      const list = j?.data?.list;
      if (!Array.isArray(list)) return null;
      const kept = asof ? list.filter((x) => String(x.notice_date ?? '').slice(0, 10) <= asof) : list;
      return kept.map((x) => ({
        date: (x.notice_date ?? '').slice(0, 10),
        title: x.title ?? null,
        art_code: x.art_code ?? null,
      }));
    },
  });
}

/* ── 回测专用：一次性取全量原始行，供本地按时点切片 ───────── */

/** 全量估值日频行（PE/PB + 名称），默认最多 6000 行 ≈ 24 年 */
export function fetchValuationRows(code, o = {}) {
  const c = String(code).replace(/^(sh|sz|bj)/i, '');
  const filter = encodeURIComponent(`(SECURITY_CODE="${c}")`);
  const url =
    `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_VALUEANALYSIS_DET` +
    `&columns=ALL&filter=${filter}&pageNumber=1&pageSize=1000` +
    `&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB`;
  return grab({
    ...o,
    url,
    source: SOURCE_DC,
    kind: 'valuation_rows',
    code,
    parse: (j) => {
      const rows = j?.result?.data;
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return rows
        .map((r) => ({
          date: String(r.TRADE_DATE ?? '').slice(0, 10),
          pe: num(r.PE_TTM),
          pb: num(r.PB_MRQ),
          name: r.SECURITY_NAME_ABBR ?? null,
        }))
        .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
    },
  });
}

/** 全量资金流日频行 */
export function fetchFundFlowRows(code, o = {}) {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=0&klt=101&secid=${secid(code)}` +
    `&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65`;
  return grab({
    ...o,
    url,
    source: SOURCE,
    kind: 'fundflow_rows',
    code,
    parse: (j) => {
      const ks = j?.data?.klines;
      if (!Array.isArray(ks) || ks.length === 0) return null;
      return ks.map((l) => {
        const p = l.split(',');
        return {
          date: p[0],
          main_net: num(p[1]),
          small_net: num(p[2]),
          medium_net: num(p[3]),
          large_net: num(p[4]),
          super_net: num(p[5]),
        };
      });
    },
  });
}

/** 全量财务报告列表（按报告期倒序） */
export function fetchFinancialsList(code, o = {}) {
  const c = String(code).replace(/^(sh|sz|bj)/i, '');
  const suffix = /^6/.test(c) || /^900/.test(c) ? 'SH' : /^(0|3|2)/.test(c) ? 'SZ' : 'BJ';
  const filter = encodeURIComponent(`(SECUCODE="${c}.${suffix}")`);
  const url =
    `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA` +
    `&columns=ALL&filter=${filter}&pageNumber=1&pageSize=40` +
    `&sortColumns=REPORT_DATE&sortTypes=-1&source=HSF10&client=PC`;
  return grab({
    ...o,
    url,
    source: SOURCE_DC,
    kind: 'financials_list',
    code,
    parse: (j) => {
      const list = j?.result?.data;
      if (!Array.isArray(list) || list.length === 0) return null;
      return list.map((d) => {
        const roeReported = num(d.ROEJQ);
        const rname = d.REPORT_DATE_NAME ?? '';
        const factor = /一季/.test(rname) ? 4 : /中报|半年/.test(rname) ? 2 : /三季/.test(rname) ? 4 / 3 : 1;
        return {
          report_date: String(d.REPORT_DATE ?? '').slice(0, 10),
          notice_date: String(d.NOTICE_DATE ?? d.REPORT_DATE ?? '').slice(0, 10),
          report_name: rname,
          name: d.SECURITY_NAME_ABBR ?? null,
          eps: num(d.EPSJB),
          bps: num(d.BPS),
          roe: roeReported === null ? null : Number((roeReported * factor).toFixed(2)),
          roe_reported: roeReported,
          revenue_yoy: num(d.TOTALOPERATEREVETZ),
          netprofit_yoy: num(d.PARENTNETPROFITTZ),
          gross_margin: num(d.XSMLL),
          net_margin: num(d.XSJLL),
          debt_ratio: num(d.ZCFZL),
          ocf_per_share: num(d.MGJYXJJE),
        };
      });
    },
  });
}
