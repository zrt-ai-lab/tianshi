import { fetchRegulatory, fetchConceptMembership } from '../core/event-context.mjs';
import { isNoiseConcept } from '../core/rotation.mjs';
import { buildSectorLadders } from '../core/ladder-sectors.mjs';
import { fetchTrackerClose } from '../core/etftracker.mjs';
/**
 * 天市 · DSH 插件 Host 半边
 *
 * 只做一件事：把项目根目录的分析流水线暴露成 loopback HTTP 路由，
 * 供左侧看板（./client.js）调用。
 *
 * 安全：所有路由只应答本机回环请求（socket 地址 + Host 头双重校验），
 * 与 dsh 自身的 loopback trust fence 保持一致。
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { gather } from '../core/gather.mjs';
import { runPipeline } from '../core/pipeline.mjs';
import { computeDecision } from '../core/decision.mjs';
import { fetchMarket, interpretMarket } from '../core/market.mjs';
import { marketCycle, stockStage } from '../core/cycle.mjs';
import { horizonViews, capitalStructure } from '../core/horizons.mjs';
import { fetchNews } from '../core/news.mjs';
import { buildUserPrompt, ANALYST_SYSTEM } from '../core/prompt.mjs';
import { fetchDividends, assessLongTerm } from '../core/longterm.mjs';
import { PRINCIPLES, QUIPS, BOUNDARY } from '../core/philosophy.mjs';
import { intradayStats, orderBookStats, buildTStrategy, fetchOrderBook } from '../core/intraday.mjs';
import { analyzeLimitUp, fetchSectorMembers, marketOf } from '../core/limitup.mjs';
import { buildOpinion } from '../core/opinion.mjs';
import { advisePosition } from '../core/position.mjs';
import { getSourceRegistry } from '../core/sources-registry.mjs';
import { fetchGubaPosts, analyzeSentiment } from '../core/sentiment.mjs';
import { fetchAllStocks, localSearch } from '../core/stocklist.mjs';
import { fetchPool, previousTradeDate, buildLadder, crossYearCandidates, crossYearWindow, interpretPromotion } from '../core/ladder.mjs';
import { scanMonsters } from '../core/monster.mjs';
import { buildRootCause, summarizeRootCause } from '../core/rootcause.mjs';
import { parseDefaultModel } from '../core/modelconfig.mjs';
import { fetchRotation } from '../core/rotation.mjs';
import { fetchTicks, openStrength, sectorMomentum, buildPathways } from '../core/realtime.mjs';
import { renderReport } from '../core/report.mjs';
import { checkEvidenceChain } from '../core/provenance.mjs';

export const name = 'tianshi';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const STARTED_AT = Date.now();
const DATA_ROOT = (() => {
  const dir = process.env.TIANSHI_ROOT || join(homedir(), '.dsh', 'tianshi-data');
  try { mkdirSync(dir, { recursive: true }); } catch { /* 权限问题时不阻断 */ }
  return dir;
})();
const ROUTE_PATHS = [];

/* ── 模型路由：从 profile 配置读默认模型，读不到用兜底 ── */
function resolveModel() {
  try {
    const argv = process.argv.join(' ');
    const m = argv.match(/([^\s]*\/profiles\/[^\s/]+)/);
    if (m) {
      const yml = readFileSync(join(m[1], 'cordis.patch.yml'), 'utf8');
      const parsed = parseDefaultModel(yml);
      if (parsed) return parsed;
    }
  } catch { /* 读不到就用兜底 */ }
  return { provider: 'deepseek-account', model: 'deepseek-flash' };
}

/** 需要 webServer 服务才能挂路由 */
export const inject = ['webServer', 'llm'];

// 版本从 package.json 实时读取，不要硬编码（硬编码会和实际发布版本脱节）
const PKG_VERSION = (() => {
  try {
    const raw = readFileSync(join(PLUGIN_DIR, '..', 'package.json'), 'utf8');
    return JSON.parse(raw).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

/* ── loopback 校验 ─────────────────────────────────────── */

function isIPv4Loopback(v4) {
  const parts = String(v4).split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isLoopbackAddress(addr) {
  if (addr === undefined) return false;
  const a = String(addr).toLowerCase();
  if (a === '::1') return true;
  if (a.startsWith('::ffff:')) return isIPv4Loopback(a.slice(7));
  return isIPv4Loopback(a);
}

function isLoopbackRequest(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  const host = req.headers?.host;
  if (typeof host !== 'string') return false;
  let hostname;
  try {
    hostname = new URL('http://' + host).hostname;
  } catch {
    return false;
  }
  return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || isIPv4Loopback(hostname);
}

/* ── HTTP 小工具 ───────────────────────────────────────── */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res, status, text, type = 'text/markdown; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/* ── 轻量 JSON 请求（带超时） ─────────────────────────── */

async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
        Referer: 'https://quote.eastmoney.com/',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ── 缓存：同一标的 60 秒内复用，避免看板反复触发全量抓取 ── */

const CACHE_TTL_MS = 60_000;
const CACHE_TTL_FAST = 5_000;   // 行情类：只缓存 5 秒
const cache = new Map(); // symbol -> { at, payload }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  const ttl = hit.ttl ?? CACHE_TTL_MS;
  if (Date.now() - hit.at > ttl) {
    cache.delete(key);
    return null;
  }
  return hit.payload;
}

function cacheSet(key, payload, ttl = CACHE_TTL_MS) {
  cache.set(key, { at: Date.now(), payload, ttl });
  // 简单容量控制：超过 32 个标的先清最旧的
  if (cache.size > 32) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

/* ── 业务：跑一次七政体检 ─────────────────────────────── */

const inflight = new Map(); // symbol -> Promise（并发去重）

async function analyze(symbol) {
  if (inflight.has(symbol)) return inflight.get(symbol);
  const task = (async () => {
    const facts = await gather(symbol, { rootDir: DATA_ROOT });
    if (!facts.quote) throw new Error('行情快照取数失败（数据闸 fail），拒绝出卡');
    const result = runPipeline(facts);
    return { facts, result };
  })();
  inflight.set(symbol, task);
  try {
    return await task;
  } finally {
    inflight.delete(symbol);
  }
}

async function shapePayload(symbol, facts, result, position = null) {
  const { card } = result;
  const chain = checkEvidenceChain(card, facts);
  let decision = null;
  let stage = null;
  let horizons = null;
  let capital = null;
  let longterm = null;
  try {
    const dv = await fetchDividends(facts.symbol);
    longterm = assessLongTerm(facts, dv);
  } catch (e) { longterm = null; }
  try { stage = stockStage(facts); } catch (e) { stage = null; }
  try { decision = computeDecision(facts, card, stage, longterm); } catch (e) { decision = null; }
  try { capital = capitalStructure(facts.fund_flow); } catch (e) { capital = null; }
  try { horizons = horizonViews(facts, card, stage, null, null); } catch (e) { horizons = null; }
  let positionAdvice = null;
  try {
    if (position && position.cost > 0) {
      positionAdvice = advisePosition({
        price: facts.quote?.price ?? null,
        cost: position.cost,
        qty: position.qty ?? null,
        decision, stage, risk: card.risk,
      });
    }
  } catch (e) { positionAdvice = null; }
  let opinion = null;
  try {
    const cachedMarket = cacheGet('market');
    const mcycle = cachedMarket?.cycle ?? null;
    opinion = buildOpinion({ facts, card, decision, stage, longterm, marketCycle: mcycle, news: null });
  } catch (e) { opinion = null; }
  return {
    ok: true,
    symbol,
    name: facts.name ?? null,
    trade_date: facts.trade_date,
    fetched_at: facts.fetched_at,
    is_trading: facts.is_trading,
    card,
    decision,
    stage,
    horizons,
    capital,
    longterm,
    opinion,
    position_advice: positionAdvice,
    // 看板需要的精简事实（避免把上万根 K 线塞进响应）
    quote: facts.quote,
    financials: facts.financials,
    valuation: facts.valuation_pct,
    fund_flow: facts.fund_flow
      ? {
          trade_date: facts.fund_flow.trade_date,
          main_net: facts.fund_flow.main_net,
          main_net_5d: facts.fund_flow.main_net_5d,
          main_net_20d: facts.fund_flow.main_net_20d,
          today_date: facts.fund_flow.today_date,
          today_main_net: facts.fund_flow.today_main_net,
        }
      : null,
    sector: facts.sector,
    missing: facts.missing,
    conflicts: facts.conflicts,
    validation: { errors: result.errors, ok: result.ok, chain_checked: chain.checked, chain_ok: chain.ok },
    evidence_count: facts.evidence.length,
    evidence_failed: facts.evidence.filter((e) => !e.ok).length,
  };
}

function routePaths() { return ROUTE_PATHS.slice(); }

function makeRoutes(logger, ctx) {
  const routes = [];
  ROUTE_PATHS.length = 0;

  routes.push({
    kind: 'exact',
    path: '/api/tianshi/health',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      const required = ['workbench', 'kline', 'search', 'hot', 'card', 'market', 'minutes', 'analyze', 'news', 'company', 'tstrat', 'limitup', 'philosophy', 'selftest'];
      const have = routePaths();
      const missing = required.filter((r) => !have.some((pth) => pth.endsWith('/' + r)));
      let model = null;
      try { model = resolveModel(); } catch { model = null; }
      sendJson(res, 200, {
        ok: true,
        plugin: 'dsh-tianshi',
        version: PKG_VERSION,
        cache: cache.size,
        routes: have,
        missing_routes: missing,
        model,
        llm: Boolean(ctx?.llm),
        uptime_sec: Math.round((Date.now() - STARTED_AT) / 1000),
      });
    },
  });

  // GET /api/tianshi/workbench → 工作台页面（也可直接在浏览器打开）
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/workbench',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      try {
        const html = readFileSync(join(PLUGIN_DIR, 'workbench.html'), 'utf8');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(html),
        });
        res.end(html);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/kline?symbol=600519&lmt=250 → 日 K + 均线（给工作台的图表用）
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/kline',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
      const symbol = (url.searchParams.get('symbol') ?? '').trim().replace(/^(sh|sz|bj)/i, '');
      if (!/^\d{6}$/.test(symbol)) return sendJson(res, 400, { ok: false, error: 'symbol 必须是 6 位数字代码' });
      const lmt = Math.min(Math.max(Number(url.searchParams.get('lmt') ?? 160) || 160, 30), 1000);
      try {
        const { fetchKline } = await import('../core/sources/eastmoney.mjs');
        const r = await fetchKline(symbol, { rootDir: process.cwd(), lmt });
        if (!r.data) return sendJson(res, 502, { ok: false, error: 'K 线取数失败' });
        sendJson(res, 200, { ok: true, symbol, bars: r.data });
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/market → 大盘体检 + 国家队痕迹
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/market',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      const key = 'market';
      const cachedMk = cacheGet(key);
      if (cachedMk) return sendJson(res, 200, { ...cachedMk, cached: true });
      try {
        const m = await fetchMarket();
        const interp = interpretMarket(m);
        const cycle = marketCycle(m);
        const out = { ok: true, ...m, interp, cycle };
        cacheSet(key, out);
        sendJson(res, 200, out);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/flowintraday?symbol=600900 → 分时资金流（逐分钟累计）
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/flowintraday',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
      const symbol = (url.searchParams.get('symbol') ?? '').trim().replace(/^(sh|sz|bj)/i, '');
      if (!/^\d{6}$/.test(symbol)) return sendJson(res, 400, { ok: false, error: 'symbol 必须是 6 位数字代码' });
      const key = `flowintra:${symbol}`;
      const hit = cacheGet(key);
      if (hit) return sendJson(res, 200, { ...hit, cached: true });
      try {
        const { secid } = await import('../core/sources/eastmoney.mjs');
        const j = await fetchJson(
          `https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?secid=${secid(symbol)}` +
          `&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56&klt=1&lmt=0`,
        );
        const flow = (j?.data?.klines ?? []).map((line) => {
          const p2 = line.split(',');
          return {
            t: p2[0], main: Number(p2[1]), small: Number(p2[2]),
            medium: Number(p2[3]), large: Number(p2[4]), super: Number(p2[5]),
          };
        });
        const out = { ok: true, symbol, name: j?.data?.name ?? null, flow };
        cacheSet(key, out, CACHE_TTL_FAST);
        sendJson(res, 200, out);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/live?symbol=600900 → 轻量实时行情（大盘条 + 个股），3 秒缓存
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/live',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
      const symbol = (url.searchParams.get('symbol') ?? '').trim().replace(/^(sh|sz|bj)/i, '');
      const key = `live:${symbol || 'idx'}`;
      const hit = cacheGet(key);
      if (hit) return sendJson(res, 200, { ...hit, cached: true });
      try {
        const out = { ok: true, at: Date.now(), indices: null, stock: null };
        // 大盘七指数（东财 ulist 轻量）
        try {
          const j = await fetchJson(
            'https://push2.eastmoney.com/api/qt/ulist.np/get?secids=1.000001,0.399001,0.399006,1.000688,1.000300,1.000905,1.000852' +
            '&fields=f2,f3,f6,f12,f14,f104,f105',
          );
          const rows = j?.data?.diff ?? [];
          out.indices = rows.map((x) => ({
            name: x.f14,
            price: typeof x.f2 === 'number' ? x.f2 / 100 : null,
            pct: typeof x.f3 === 'number' ? x.f3 / 100 : null,
            up: x.f104 ?? null, down: x.f105 ?? null,
          }));
          const sh = out.indices.find((i) => i.name === '上证指数');
          const sz = out.indices.find((i) => i.name === '深证成指');
          if (sh && sz) out.breadth = { up: (sh.up ?? 0) + (sz.up ?? 0), down: (sh.down ?? 0) + (sz.down ?? 0) };
        } catch { out.indices = null; }
        // 个股实时
        if (/^\d{6}$/.test(symbol)) {
          try {
            const mk = /^(6|9)/.test(symbol) ? 'sh' : /^(83|87|88|92|43|82|4)/.test(symbol) ? 'bj' : 'sz';
            const res2 = await fetch(`https://qt.gtimg.cn/q=${mk}${symbol}`, {
              headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' },
            });
            const text = new TextDecoder('gbk').decode(Buffer.from(await res2.arrayBuffer()));
            const m = text.match(/v_[a-z]{2}\d{6}="([^"]*)"/);
            if (m) {
              const f = m[1].split('~');
              const num = (v) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : null);
              out.stock = {
                symbol,
                price: num(f[3]), pct: num(f[32]), high: num(f[33]), low: num(f[34]),
                pre_close: num(f[4]), open: num(f[5]),
                volume_lots: num(f[6]), amount: num(f[37]) === null ? null : num(f[37]) * 1e4,
                time: f[30] ?? null,
              };
            }
          } catch { out.stock = null; }
        }
        cacheSet(key, out, 3000);
        sendJson(res, 200, out);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/indexintraday?code=000001 → 指数当日分时（真实数据）
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/indexintraday',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
      const code = (url.searchParams.get('code') ?? '000001').trim();
      if (!/^\d{6}$/.test(code)) return sendJson(res, 400, { ok: false, error: 'code 必须是 6 位数字' });
      const key = `idx:${code}`;
      const hit = cacheGet(key);
      if (hit) return sendJson(res, 200, { ...hit, cached: true });
      // 指数 secid：上证系 1.xxxxxx，深证系 0.xxxxxx
      const secid = /^(000|880|999)/.test(code) ? `1.${code}` : `0.${code}`;
      try {
        const j = await fetchJson(
          `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}` +
          `&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=1`,
        );
        const d = j?.data;
        if (!d) return sendJson(res, 502, { ok: false, error: '指数分时取数失败' });
        const points = (d.trends ?? []).map((line) => {
          const p2 = line.split(',');
          return { t: p2[0], close: Number(p2[2]), high: Number(p2[3]), low: Number(p2[4]), volume: Number(p2[5]), amount: Number(p2[6]), avg: Number(p2[7]) };
        });
        const out = { ok: true, code, name: d.name ?? null, pre_close: d.preClose ?? null, points };
        cacheSet(key, out, CACHE_TTL_FAST);
        sendJson(res, 200, out);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/realtime?symbol=600519 → 实时盘面（单数/开盘强度/板块动量/赚钱路径）
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/realtime',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
      const symbol = (url.searchParams.get('symbol') ?? '').trim().replace(/^(sh|sz|bj)/i, '');
      if (!/^\d{6}$/.test(symbol)) return sendJson(res, 400, { ok: false, error: 'symbol 必须是 6 位数字代码' });
      const key = `realtime:${symbol}`;
      const hit = cacheGet(key);
      if (hit) return sendJson(res, 200, { ...hit, cached: true });
      try {
        const { facts, result } = await analyze(symbol);
        const bars = facts.kline_daily ?? [];
        const closes = bars.map((b) => b.close).filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
        const maEnd = (n) => (closes.length < n ? null : closes.slice(-n).reduce((a, b) => a + b, 0) / n);
        const ma20 = maEnd(20);
        const ma60 = maEnd(60);
        // ATR%
        const win = bars.slice(-15);
        let atrPct = null;
        if (win.length > 2) {
          const trs = [];
          for (let i = 1; i < win.length; i++) {
            const c = win[i], pv = win[i - 1];
            trs.push(Math.max(c.high - c.low, Math.abs(c.high - pv.close), Math.abs(c.low - pv.close)));
          }
          const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
          const last = win[win.length - 1].close;
          atrPct = last ? (atr / last) * 100 : null;
        }
        let stage = null;
        try { stage = stockStage(facts); } catch { stage = null; }
        let longterm = null;
        try { longterm = assessLongTerm(facts, await fetchDividends(symbol)); } catch { longterm = null; }

        const [ticks, sec, trends] = await Promise.all([
          fetchTicks(symbol, 3).catch(() => null),
          sectorMomentum(facts.sector?.code, facts.sector?.name).catch(() => null),
          (async () => {
            try {
              const { secid } = await import('../core/sources/eastmoney.mjs');
              const t = await fetchJson(`https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid(symbol)}` +
                `&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=1`);
              return (t?.data?.trends ?? []).map((line) => {
                const p2 = line.split(',');
                return { t: p2[0], close: Number(p2[2]), high: Number(p2[3]), low: Number(p2[4]), volume: Number(p2[5]), avg: Number(p2[7]) };
              });
            } catch { return null; }
          })(),
        ]);
        const preClose = facts.quote?.prev_close ?? null;
        const open = openStrength(trends, preClose);
        const pathways = buildPathways({
          price: facts.quote?.price ?? null,
          atrPct,
          ma20, ma60,
          pePct: facts.valuation_pct?.pe_ttm_pct ?? null,
          stageKey: stage?.stage?.key ?? null,
          longtermKey: longterm?.style?.key ?? null,
          volRatio: facts.quote?.volume_ratio ?? null,
          sector: facts.sector ?? null,
        });
        const out = { ok: true, symbol, name: facts.name, ticks, open, sector_momentum: sec, pathways, atr_pct: atrPct, ma20, ma60 };
        cacheSet(key, out);
        sendJson(res, 200, out);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/tstrat?symbol=600900 → 做T分析（分时 + 盘口）
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/tstrat',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
      const symbol = (url.searchParams.get('symbol') ?? '').trim().replace(/^(sh|sz|bj)/i, '');
      if (!/^\d{6}$/.test(symbol)) return sendJson(res, 400, { ok: false, error: 'symbol 必须是 6 位数字代码' });
      const key = `tstrat:${symbol}`;
      const hit = cacheGet(key);
      if (hit) return sendJson(res, 200, { ...hit, cached: true });
      try {
        const { facts, result } = await analyze(symbol);
        const { secid } = await import('../core/sources/eastmoney.mjs');
        const [trends, ob, flowRaw] = await Promise.all([
          fetchJson(`https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid(symbol)}` +
            `&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=1`).catch(() => null),
          fetchOrderBook(symbol).catch(() => null),
          fetchJson(`https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?secid=${secid(symbol)}` +
            `&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56&klt=1&lmt=0`).catch(() => null),
        ]);
        // 分时资金流：主力/小单/中单/大单/超大单（累计值，逐分钟）
        const flow = (flowRaw?.data?.klines ?? []).map((line) => {
          const p2 = line.split(',');
          return {
            t: p2[0], main: Number(p2[1]), small: Number(p2[2]),
            medium: Number(p2[3]), large: Number(p2[4]), super: Number(p2[5]),
          };
        });
        const points = (trends?.data?.trends ?? []).map((line) => {
          const p = line.split(',');
          return { t: p[0], open: Number(p[1]), close: Number(p[2]), high: Number(p[3]), low: Number(p[4]), volume: Number(p[5]), amount: Number(p[6]), avg: Number(p[7]) };
        });
        const preClose = trends?.data?.preClose ?? ob?.pre_close ?? null;
        const st = intradayStats(points, preClose);
        const obStats = orderBookStats(ob);
        const t = buildTStrategy(st, obStats, {
          pctChg: facts.quote?.pct_chg ?? null,
          limitUp: false,
          riskLevel: result.card?.risk?.level ?? null,
        });
        const out = { ok: true, symbol, name: facts.name ?? null, pre_close: preClose, orderbook: ob, strategy: t, stats: st, ob_stats: obStats, flow };
        cacheSet(key, out);
        sendJson(res, 200, out);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/limitup?symbol=002578 → 涨停归因 + 同题材弹性标的
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/limitup',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
      const symbol = (url.searchParams.get('symbol') ?? '').trim().replace(/^(sh|sz|bj)/i, '');
      if (!/^\d{6}$/.test(symbol)) return sendJson(res, 400, { ok: false, error: 'symbol 必须是 6 位数字代码' });
      const key = `limitup:${symbol}`;
      const hit = cacheGet(key);
      if (hit) return sendJson(res, 200, { ...hit, cached: true });
      try {
        const { facts } = await analyze(symbol);
        const mkt = marketOf(symbol);
        const chg = facts.quote?.pct_chg ?? null;
        if (chg === null || chg < mkt.limit_pct - 0.5) {
          return sendJson(res, 200, { ok: true, symbol, is_limitup: false, pct: chg, market: mkt });
        }
        // 今日涨停池
        const d = new Date();
        const p2 = (n) => String(n).padStart(2, '0');
        const ymd = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
        const poolJson = await fetchJson(
          `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt` +
          `&Pageindex=0&pagesize=200&sort=lbc%3Adesc&date=${ymd}`,
        ).catch(() => null);
        const pool = (poolJson?.data?.pool ?? []).find((x) => String(x.c) === symbol) ?? null;

        const [members, news] = await Promise.all([
          fetchSectorMembers(facts.sector?.code, 100).catch(() => []),
          fetchNews(facts, { limit: 12 }).catch(() => null),
        ]);
        const analysis = analyzeLimitUp({ facts, pool, members, news, pct: chg });
        const out = { ok: true, symbol, name: facts.name, sector: facts.sector?.name ?? null, ...analysis };
        cacheSet(key, out);
        sendJson(res, 200, out);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/philosophy → 投研理念与文案
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/philosophy',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      sendJson(res, 200, { ok: true, principles: PRINCIPLES, quips: QUIPS, boundary: BOUNDARY });
    },
  });

  // GET /api/tianshi/sentiment?symbol=600900 → 股吧舆情（东财，热榜与情绪）
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/sentiment',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
      const symbol = (url.searchParams.get('symbol') ?? '').trim().replace(/^(sh|sz|bj)/i, '');
      if (!/^\d{6}$/.test(symbol)) return sendJson(res, 400, { ok: false, error: 'symbol 必须是 6 位数字代码' });
      const key = `sentiment:${symbol}`;
      const hit = cacheGet(key);
      if (hit) return sendJson(res, 200, { ...hit, cached: true });
      try {
        const g = await fetchGubaPosts(symbol, 2);
        const out = { ok: true, symbol, source: '东方财富股吧', ...analyzeSentiment(g.posts, g.errors) };
        cacheSet(key, out, CACHE_TTL_FAST);
        sendJson(res, 200, out);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/sources?symbol=600900 → 数据来源与交叉验证清单（可现场跑一次比对）
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/sources',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
      const symbol = (url.searchParams.get('symbol') ?? '').trim().replace(/^(sh|sz|bj)/i, '');
      const out = getSourceRegistry();
      if (/^\d{6}$/.test(symbol)) {
        try {
          const mk = /^(6|9)/.test(symbol) ? 'sh' : /^(83|87|88|92|43|82|4)/.test(symbol) ? 'bj' : 'sz';
          const [tRes, eRes] = await Promise.all([
            fetch(`https://qt.gtimg.cn/q=${mk}${symbol}`, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' } }),
            fetchJson(`https://push2.eastmoney.com/api/qt/stock/get?secid=${mk === 'sh' ? '1' : '0'}.${symbol}&fields=f43,f44,f45,f46,f57,f58,f60,f170`),
          ]);
          const tText = new TextDecoder('gbk').decode(Buffer.from(await tRes.arrayBuffer()));
          const m = tText.match(/v_[a-z]{2}\d{6}="([^"]*)"/);
          const tf = m ? m[1].split('~') : null;
          const ed = eRes?.data ?? null;
          const tencent = tf ? { price: Number(tf[3]), pct: Number(tf[32]) } : null;
          const eastmoney = ed ? { price: ed.f43 / 100, pct: ed.f170 / 100 } : null;
          const diffs = [];
          if (tencent && eastmoney) {
            const dp = Math.abs(tencent.price - eastmoney.price);
            if (dp > 0.011) diffs.push({ field: 'price', tencent: tencent.price, eastmoney: eastmoney.price, delta: Number(dp.toFixed(3)) });
            const dc = Math.abs(tencent.pct - eastmoney.pct);
            if (dc > 0.05) diffs.push({ field: 'pct_chg', tencent: tencent.pct, eastmoney: eastmoney.pct, delta: Number(dc.toFixed(3)) });
          }
          out.live_check = {
            symbol,
            at: new Date().toISOString(),
            tencent, eastmoney,
            consistent: tencent && eastmoney ? diffs.length === 0 : null,
            diffs,
            note: '两个独立接口同一时刻取值比对；收盘后通常一致，盘中有秒级延迟时可能短暂不一致',
          };
        } catch (e) {
          out.live_check = { symbol, error: String(e?.message ?? e), tencent: null, eastmoney: null };
        }
      }
      sendJson(res, 200, out);
    },
  });

  // GET /api/tianshi/selftest → 分析链路自检（不联网、不调模型）
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/selftest',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      const steps = [];
      const run = (name, fn) => {
        try { const detail = fn(); steps.push({ name, ok: true, detail }); return true; }
        catch (e) { steps.push({ name, ok: false, error: String(e?.message ?? e) }); return false; }
      };
      // 合成事实包：结构与 gather 输出一致，用来验证纯计算链路
      const fakeFacts = {
        symbol: '600519', name: '自检样本', trade_date: '2026-01-01',
        quote: { price: 100, pct_chg: 1, open: 99, high: 101, low: 98, prev_close: 99, turnover_rate: 1, amplitude: 2 },
        kline_daily: Array.from({ length: 70 }, (_, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, open: 90 + i, close: 91 + i, high: 92 + i, low: 89 + i, volume: 1e6 })),
        financials: { report_name: '自检', roe: 15, revenue_yoy: 5, netprofit_yoy: 3, gross_margin: 40, net_margin: 20, debt_ratio: 30 },
        valuation_pct: { current_pe: 20, pe_ttm_pct: 50, current_pb: 3, pb_pct: 40, window_years: 3 },
        fund_flow: { trade_date: '2026-01-01', main_net: 1e7, main_net_5d: 2e7, main_net_20d: -1e7, today_main_net: 5e6, super_net: 6e6, large_net: 4e6, medium_net: -3e6, small_net: -7e6 },
        sector: { matched: true, name: '自检行业', pct_chg: 1, main_net: 1e7, rank_of_total: 10, total: 100 },
        billboard: [], announcements: [], missing: [], conflicts: [],
      };
      const fakeCard = { risk: { level: 3, position_cap_pct: 8 }, gates: { data: { status: 'pass' } } };
      const fakeMarket = {
        indices: [{ name: '沪深300', pct: 0.5 }, { name: '中证1000', pct: 0.2 }],
        breadth: { up: 2500, down: 2000, up_ratio: 55 },
        limit: { up: 60, down: 5, broken: 20, broken_rate: 25, max_board: 5, lianban_count: 8 },
        amount: { total: 1e12, sh: 5e11, sh_prev: 4.8e11, sh_change_pct: 4 },
        etfs: [{ name: '沪深300ETF华泰柏瑞', amount: 3e9, avg20: 3e9, ratio: 1.2, progress: 70, active_net: 1e8 }],
        sectors: { top: [{ name: '银行', pct: 1 }], bottom: [], total: 30 },
      };

      let stage = null;
      run('stockStage 个股阶段', () => { stage = stockStage(fakeFacts); return stage.stage?.name ?? 'null'; });
      run('computeDecision 五维决策', () => { const d = computeDecision(fakeFacts, fakeCard, stage); return `verdict=${d.verdict} total=${d.total}`; });
      run('capitalStructure 资金结构', () => { const c = capitalStructure(fakeFacts.fund_flow); return c?.pattern ?? 'null'; });
      run('horizonViews 三周期', () => { const h = horizonViews(fakeFacts, fakeCard, stage, null, null); return Object.keys(h).join(','); });
      run('marketCycle 情绪周期', () => marketCycle(fakeMarket).stage?.name ?? 'null');
      run('interpretMarket 国家队痕迹', () => { const i = interpretMarket(fakeMarket); return `${i.footprint}/${i.hitCount}`; });
      run('resolveModel 模型路由', () => { const m = resolveModel(); return `${m.provider}/${m.model}`; });
      run('summarizeFacts 素材构建', () => {
        const out = summarizeFacts(fakeFacts, fakeCard, computeDecision(fakeFacts, fakeCard, stage), {});
        if (/undefined|NaN/.test(out)) throw new Error('素材中出现 undefined/NaN');
        return `${out.length} 字符`;
      });
      let promptPreview = null;
      run('buildUserPrompt 提示词', () => {
        const p = buildUserPrompt(fakeFacts, fakeCard, computeDecision(fakeFacts, fakeCard, stage), { marketLine: '自检', stageLine: '自检' }, {});
        if (/undefined|NaN/.test(p)) throw new Error('提示词中出现 undefined/NaN');
        promptPreview = p.slice(0, 400);
        return `${p.length} 字符`;
      });
      sendJson(res, 200, { ok: steps.every((x) => x.ok), steps, prompt_preview: promptPreview });
    },
  });

  // GET /api/tianshi/company?symbol=600519 → 公司面（股东/主营/解禁/研报/龙虎榜席位）
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/company',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
      const symbol = (url.searchParams.get('symbol') ?? '').trim().replace(/^(sh|sz|bj)/i, '');
      if (!/^\d{6}$/.test(symbol)) return sendJson(res, 400, { ok: false, error: 'symbol 必须是 6 位数字代码' });
      const key = `company:${symbol}`;
      const hit = cacheGet(key);
      if (hit) return sendJson(res, 200, { ...hit, cached: true });
      try {
        const mod = await import('../core/company.mjs');
        const { facts } = await analyze(symbol);
        const company = await mod.fetchCompany(facts, {});
        cacheSet(key, company);
        sendJson(res, 200, company);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/news?symbol=600519 → 消息面 / 政策面
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/news',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
      const symbol = (url.searchParams.get('symbol') ?? '').trim().replace(/^(sh|sz|bj)/i, '');
      if (!/^\d{6}$/.test(symbol)) return sendJson(res, 400, { ok: false, error: 'symbol 必须是 6 位数字代码' });
      const key = `news:${symbol}`;
      const hit = cacheGet(key);
      if (hit) return sendJson(res, 200, { ...hit, cached: true });
      try {
        const { facts } = await analyze(symbol);
        const news = await fetchNews(facts, { limit: 12 });
        cacheSet(key, news);
        sendJson(res, 200, news);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/minutes?symbol=600519&days=1 → 分时（1/5 日）
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/minutes',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
      const symbol = (url.searchParams.get('symbol') ?? '').trim().replace(/^(sh|sz|bj)/i, '');
      if (!/^\d{6}$/.test(symbol)) return sendJson(res, 400, { ok: false, error: 'symbol 必须是 6 位数字代码' });
      const days = Number(url.searchParams.get('days') ?? 1) === 5 ? 5 : 1;
      const { secid } = await import('../core/sources/eastmoney.mjs');
      try {
        const payload = await fetchJson(
          `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid(symbol)}` +
          `&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=${days}`,
        );
        const d = payload?.data;
        if (!d) return sendJson(res, 502, { ok: false, error: '分时取数失败' });
        const points = (d.trends ?? []).map((line) => {
          const p = line.split(',');
          return {
            t: p[0], open: Number(p[1]), close: Number(p[2]), high: Number(p[3]),
            low: Number(p[4]), volume: Number(p[5]), amount: Number(p[6]), avg: Number(p[7]),
          };
        });
        sendJson(res, 200, { ok: true, symbol, name: d.name ?? null, preClose: d.preClose ?? null, days, points });
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/analyze?symbol=600519 → AI 深度解读（SSE 流式）
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/analyze',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
      const symbol = (url.searchParams.get('symbol') ?? '').trim().replace(/^(sh|sz|bj)/i, '');
      if (!/^\d{6}$/.test(symbol)) return sendJson(res, 400, { ok: false, error: 'symbol 必须是 6 位数字代码' });
      const qCost = Number(url.searchParams.get('cost'));
      const qQty = Number(url.searchParams.get('qty'));
      const clientPos = Number.isFinite(qCost) && qCost > 0 ? { cost: qCost, qty: Number.isFinite(qQty) ? qQty : null } : null;

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 客户端断开 */ } };
      let closed = false;
      req.on('close', () => { closed = true; });

      try {
        send({ type: 'status', text: '正在采集全维度数据…' });
        const { facts, result } = await analyze(symbol);
        send({ type: 'status', text: '正在采集公司面数据…' });
        let company = null;
        try {
          const mod = await import('../core/company.mjs');
          company = await mod.fetchCompany(facts, {});
        } catch (e) { company = null; }
        send({ type: 'status', text: '正在抓取股吧网友观点…' });
        let sentiment = null;
        try {
          const g = await fetchGubaPosts(symbol, 2);
          sentiment = analyzeSentiment(g.posts, g.errors);
        } catch (e) { sentiment = null; }
        send({ type: 'status', text: '正在拆解涨跌根因（大盘 → 板块 → 海外映射）…' });
        let rootcause = null;
        try {
          const cachedRc = cacheGet(`rootcause:${symbol}`);
          rootcause = cachedRc ?? await buildRootCause(symbol, facts);
        } catch (e) { rootcause = null; }
        send({ type: 'status', text: '正在检索政策与新闻…' });
        let news = null;
        try { news = await fetchNews(facts, { limit: 12 }); } catch (e) { news = null; }
        send({ type: 'status', text: '正在计算五维评分…' });
        let st = null;
        try { st = stockStage(facts); } catch (e) { st = null; }
        let longterm = null;
        try {
          const dv = await fetchDividends(facts.symbol);
          longterm = assessLongTerm(facts, dv);
        } catch (e) { longterm = null; }
        const decision = computeDecision(facts, result.card, st, longterm);
        let capital = null;
        let horizons = null;
        try { capital = capitalStructure(facts.fund_flow); } catch (e) { capital = null; }
        try { horizons = horizonViews(facts, result.card, st, null, null); } catch (e) { horizons = null; }
        let extra = null;
        try {
          let marketLine = '大盘数据不可用';
          try {
            const m = await fetchMarket();
            const cy = marketCycle(m);
            marketLine = `情绪周期处于「${cy.stage.name}」（置信度 ${cy.confidence}）：${cy.stage.mean}。该阶段应对：${cy.stage.do}；观察：${cy.stage.watch}。` +
              (cy.evidence.length ? ' 依据：' + cy.evidence.join('；') : '') +
              (cy.contradictions.length ? ' 矛盾信号：' + cy.contradictions.join('；') : '');
          } catch { /* 大盘取不到不影响个股分析 */ }
          extra = {
            marketLine,
            stageLine: st.stage
              ? `股价处于「${st.stage.name}」阶段：${st.evidence.join('；')}。该阶段应对：${st.stage.do}`
              : '阶段无法判断（K线不足）',
          };
        } catch { extra = null; }
        let posAdvice = null;
        try {
          if (clientPos) posAdvice = advisePosition({
            price: facts.quote?.price ?? null,
            cost: clientPos.cost, qty: clientPos.qty,
            decision, stage: st, risk: result.card?.risk,
          });
        } catch (e) { posAdvice = null; }
        const model = resolveModel();
        send({ type: 'status', text: `模型 ${model.model} 正在撰写结论…` });

        let text = '';
        const stream = ctx.llm.stream({
          provider: model.provider,
          model: model.model,
          system: ANALYST_SYSTEM,
          messages: [{ role: 'user', content: [{ type: 'text', text: buildUserPrompt(facts, result.card, decision, extra, { capital, horizons, news, company, longterm, position: posAdvice, sentiment, rootcause }) }] }],
          temperature: 0.4,
        });
        let failed = null;
        for await (const chunk of stream) {
          if (closed) break;
          if (chunk.type === 'text-delta') {
            text += chunk.text;
            send({ type: 'delta', text: chunk.text });
          } else if (chunk.type === 'finish') {
            // 模型调用失败时 finish 里带错误；不能吞掉，否则前端只能看到「没有返回内容」
            const f = chunk.reason?.kind === 'error' ? (chunk.reason.failure ?? chunk.reason) : null;
            if (f) failed = f;
            else send({ type: 'finish', reason: chunk.reason });
          }
        }
        if (failed && !text) {
          const code = failed.code ? `[${failed.code}] ` : '';
          const hint = failed.code === 'UNKNOWN_MODEL'
            ? `插件读取到的模型是 ${model.provider} / ${model.model}，在当前配置里找不到。请在设置里确认默认模型，或完全退出 DeepSeek Harness 后重开。`
            : '可能是模型服务限流、网络中断或密钥失效，稍后重试。';
          send({ type: 'error', error: `${code}${failed.message ?? '模型调用失败'}。${hint}` });
          return;
        }
        send({ type: 'done', text, decision, model: model.model });
      } catch (error) {
        logger.warn(`tianshi: analyze ${symbol} failed: ${error?.message ?? error}`);
        send({ type: 'error', error: String(error?.message ?? error) });
      } finally {
        try { res.end(); } catch { /* ignore */ }
      }
    },
  });

  // GET /api/tianshi/search?q=茅台|gzmt|600519 → 模糊搜索（汉字/拼音/代码）
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/search',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
      const q = (url.searchParams.get('q') ?? '').trim();
      if (!q) return sendJson(res, 200, { ok: true, items: [] });
      try {
        const payload = await fetchJson(
          `https://searchadapter.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14` +
          `&token=D43BF722C8E33BDC906FB84D85E326E8&count=20`,
        );
        const rows = payload?.QuotationCodeTable?.Data ?? [];
        // 东财的 Classify 对 A 股并不统一：沪A/深A 是 'AStock'，科创板是 '23'，北交所是 'NEEQ'。
        // 只按 'AStock' 过滤会把科创板与北交所全部漏掉（线上真实 bug）。
        const A_MARKETS = ['沪A', '深A', '京A', '科创板', '创业板', '主板', '北交所'];
        const items = [];
        const seen = new Set();
        for (const r of rows) {
          const code = String(r.Code ?? '');
          if (!/^\d{6}$/.test(code)) continue;
          const quoteId = String(r.QuoteID ?? '');
          const secName = String(r.SecurityTypeName ?? '');
          const classify = String(r.Classify ?? '');
          // 排除新三板（不可直接交易）：NEEQ 且不属于京A
          const isNeeq = classify === 'NEEQ' && !secName.includes('京');
          if (isNeeq) continue;
          const isA = A_MARKETS.some((m) => secName.includes(m)) || classify === 'AStock' || /^[01]\.\d{6}$/.test(quoteId);
          const isFund = classify === 'Fund' || /^(15|16|51|56|58)/.test(code);
          if (!isA && !isFund) continue;
          const key = code;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({
            code,
            name: r.Name ?? '',
            pinyin: r.PinYin ?? '',
            type: isFund ? 'fund' : 'stock',
            market: secName || null,
          });
        }
        // 兜底：接口对该关键词不返回 A 股时，用全市场名录做本地匹配
        if (items.filter((x) => x.type === 'stock').length === 0) {
          try {
            const all = await fetchAllStocks();
            for (const hit of localSearch(all, q, 16)) {
              if (seen.has(hit.code)) continue;
              seen.add(hit.code);
              items.push({ code: hit.code, name: hit.name, pinyin: '', type: 'stock', market: null });
            }
          } catch { /* 兜底失败不影响主结果 */ }
        }
        items.sort((a, b) => {
          const exact = (x) => (x.code === q || x.name === q ? 0 : x.name.startsWith(q) || x.code.startsWith(q) ? 1 : 2);
          return exact(a) - exact(b);
        });
        sendJson(res, 200, { ok: true, items });
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/ladder → 连板梯队 + 妖股潜质 + 跨年窗口
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/ladder',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      const key = 'ladder';
      const hit = cacheGet(key);
      if (hit) return sendJson(res, 200, { ...hit, cached: true });
      try {
        const now = new Date();
        const p2 = (n) => String(n).padStart(2, '0');
        const today = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
        const prev = await previousTradeDate(now);
        const [pool, prevPool] = await Promise.all([fetchPool(today), prev ? fetchPool(prev) : Promise.resolve([])]);
        const ladder = buildLadder(pool, prevPool);
        const cy = crossYearCandidates(ladder, now);
        let rotation = cacheGet('rotation');
        if (!rotation || !rotation.boards) {
          try { rotation = await fetchRotation(); if (rotation.ok) cacheSet('rotation', rotation, 180000); } catch { rotation = null; }
        }
        const sectorLadders = buildSectorLadders(pool, prevPool, rotation, { previousAvailable: !!prev && prevPool.length > 0 });
        const membership = new Map();
        const codes = [...new Set([...pool, ...prevPool].map(x => x.code))];
        let membershipFailures = 0;
        for (let start = 0; start < codes.length; start += 6) {
          await Promise.all(codes.slice(start, start + 6).map(async code => {
            try { membership.set(code, await fetchConceptMembership(code)); } catch { membershipFailures++; }
          }));
        }
        const themes = new Set();
        pool.forEach(x => (membership.get(x.code) || []).filter(n => !isNoiseConcept(n)).forEach(n => themes.add(n)));
        const conceptLadders = [...themes].map(theme => {
          const todayMembers = pool.filter(x => (membership.get(x.code) || []).includes(theme)).map(x => ({ ...x, industry: theme }));
          const previousMembers = prevPool.filter(x => (membership.get(x.code) || []).includes(theme)).map(x => ({ ...x, industry: theme }));
          const conceptRotation = rotation ? { ...rotation, boards: (rotation.boards || []).filter(x => x.kind === 'concept').map(x => ({ ...x, kind: 'industry' })), industry: rotation.concept } : null;
          return buildSectorLadders(todayMembers, previousMembers, conceptRotation, { previousAvailable: !!prev && prevPool.length > 0 })[0];
        }).filter(x => x && x.count >= 2).sort((a,b) => b.count-a.count || b.max_boards-a.max_boards).slice(0,20);

        const out = {
          ok: true,
          date: today,
          prev_date: prev,
          ladder,
          cross_year: cy.window,
          cross_year_candidates: cy.candidates,
          promotion_read: interpretPromotion(ladder),
          sector_ladders: sectorLadders,
          concept_ladders: conceptLadders,
          concept_membership_failures: membershipFailures,
          concept_note: '概念归属来自F10；一股可属多个概念，数量不可相加。归属不是实际涨停原因。失败样本不视为无概念；覆盖不足时仅供参考。',
          sector_note: '行业热度按当前涨停数量与高度描述；昨日晋级率为已发生结果，盘中会变化，不是下一交易日胜率。概念主线归因尚未验证，行业分类不等于涨停原因。',
          monster_board: ladder.levels
            .flatMap((l) => l.items)
            .filter((x) => l0(x) >= 45)
            .slice(0, 10),
          note: '妖股潜质是量价特征相似度打分，不是涨跌预测',
        };
        function l0(x) { return x.monster ? x.monster.score : 0; }
        cacheSet(key, out, 30_000);
        sendJson(res, 200, out);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/monsters → 妖股阶段扫描（埋伏/启动/一波/二波/风险）
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/monsters',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      const key = 'monsters';
      const hit = cacheGet(key);
      if (hit) return sendJson(res, 200, { ...hit, cached: true });
      try {
        const out = await scanMonsters({ maxPerStage: 8, universeLimit: 260 });
        if (!out.ok) return sendJson(res, 502, out);
        const payload = {
          ok: true,
          at: out.at,
          scanned: out.scanned,
          universe: out.universe,
          stages: out.stages,
          potential_top: out.potential_top,
          cross_year_top: out.cross_year_top,
          window_active: out.window_active,
          window_month: out.window_month,
          cross_year_rules: out.cross_year_rules,
          analysis_schema: 2,
          note: '阶段判断是形态识别，不是预测；题材是涨起来之后的叙事，不参与事前筛选',
        };
        cacheSet(key, payload, 30 * 60 * 1000);
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/hot?limit=10 → 全市场成交额榜（热门）
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/hot',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 10) || 10, 1), 30);
      const key = `hot:${limit}`;
      const cachedHot = cacheGet(key);
      if (cachedHot) return sendJson(res, 200, { ...cachedHot, cached: true });
      try {
        const payload = await fetchJson(
          `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${limit}&po=1&np=1&fltt=2&invt=2&fid=f6` +
          `&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f14,f2,f3,f6`,
        );
        const rows = payload?.data?.diff ?? [];
        const items = rows.map((r) => ({
          code: String(r.f12 ?? ''),
          name: r.f14 ?? '',
          price: typeof r.f2 === 'number' ? r.f2 : null,
          pct: typeof r.f3 === 'number' ? r.f3 : null,
          amount: typeof r.f6 === 'number' ? r.f6 : null,
        })).filter((r) => /^\d{6}$/.test(r.code));
        const out = { ok: true, items };
        cacheSet(key, out);
        sendJson(res, 200, out);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/card?symbol=600519[&refresh=1]
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/card',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try {
        url = new URL(req.url, 'http://127.0.0.1');
      } catch {
        return sendJson(res, 400, { ok: false, error: 'bad url' });
      }
      const raw = (url.searchParams.get('symbol') ?? '').trim();
      const symbol = raw.replace(/^(sh|sz|bj)/i, '');
      if (!/^\d{6}$/.test(symbol)) {
        return sendJson(res, 400, { ok: false, error: 'symbol 必须是 6 位数字代码，例如 600519' });
      }
      const refresh = url.searchParams.get('refresh') === '1';
      const key = symbol;
      if (!refresh) {
        const cached = cacheGet(key);
        if (cached) return sendJson(res, 200, { ...cached, cached: true });
      }
      try {
        const { facts, result } = await analyze(symbol);
        const cost = Number(url.searchParams.get('cost'));
        const qty = Number(url.searchParams.get('qty'));
        const pos = Number.isFinite(cost) && cost > 0 ? { cost, qty: Number.isFinite(qty) ? qty : null } : null;
        const payload = await shapePayload(symbol, facts, result, pos);
        cacheSet(key, payload);
        sendJson(res, 200, { ...payload, cached: false });
      } catch (error) {
        logger.warn(`tianshi: analyze ${symbol} failed: ${error?.message ?? error}`);
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  routes.push({
    kind: 'exact', path: '/api/tianshi/etftracker',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      const hit = cacheGet('etftracker:source');
      if (hit) return sendJson(res, 200, hit);
      try { const out = await fetchTrackerClose(); cacheSet('etftracker:source', out, 60000); sendJson(res, 200, out); }
      catch (e) { sendJson(res, 502, { ok: false, error: String(e.message || e) }); }
    },
  });

  routes.push({
    kind: 'exact', path: '/api/tianshi/regulatory',
    handler: async (req,res) => {
      if (!isLoopbackRequest(req)) return sendJson(res,403,{ok:false,error:'loopback only'});
      const symbol = new URL(req.url,'http://127.0.0.1').searchParams.get('symbol') || '';
      if (!/^\d{6}$/.test(symbol)) return sendJson(res,400,{ok:false,error:'需要6位股票代码'});
      try { sendJson(res,200,await fetchRegulatory(symbol)); }
      catch(e) { sendJson(res,502,{ok:false,error:'监管公告取数失败，不能据此判断未受监管'}); }
    }
  });

  // GET /api/tianshi/rotation → 板块轮动四象限 + 资金暗线
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/rotation',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      const key = 'rotation';
      const hit = cacheGet(key);
      if (hit) return sendJson(res, 200, { ...hit, cached: true });
      try {
        const out = await fetchRotation();
        if (!out.ok) return sendJson(res, 502, { ok: false, error: '板块列表取数失败' });
        const payload = { ...out, ok: true };
        cacheSet(key, payload, 3 * 60 * 1000);
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/sector?code=BK1036 → 板块成分股（按今日涨幅）
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/sector',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
      const code = (url.searchParams.get('code') ?? '').trim();
      if (!/^BK\d+$/.test(code)) return sendJson(res, 400, { ok: false, error: 'code 必须是 BK 开头的板块代码' });
      const key = `sector:${code}`;
      const hit = cacheGet(key);
      if (hit) return sendJson(res, 200, { ...hit, cached: true });
      try {
        const members = await fetchSectorMembers(code, 100);
        const payload = { ok: true, code, name: url.searchParams.get('name') || null, members };
        cacheSet(key, payload, CACHE_TTL_MS);
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/rootcause?symbol=600519 → 根因链路（大盘 → 板块 → 海外映射 → 个股自身）
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/rootcause',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
      const symbol = (url.searchParams.get('symbol') ?? '').trim().replace(/^(sh|sz|bj)/i, '');
      if (!/^\d{6}$/.test(symbol)) return sendJson(res, 400, { ok: false, error: 'symbol 必须是 6 位数字代码' });
      const key = `rootcause:${symbol}`;
      const hit = cacheGet(key);
      if (hit) return sendJson(res, 200, { ...hit, cached: true });
      try {
        const { facts } = await analyze(symbol);
        const rc = await buildRootCause(symbol, facts);
        const out = { ...rc, ok: true, engine_ok: rc.ok };
        cacheSet(key, out, 5 * 60 * 1000);
        sendJson(res, 200, out);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  // GET /api/tianshi/report?symbol=600519 → Markdown 全文（给"复制报告"用）
  routes.push({
    kind: 'exact',
    path: '/api/tianshi/report',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
      let url;
      try {
        url = new URL(req.url, 'http://127.0.0.1');
      } catch {
        return sendJson(res, 400, { ok: false, error: 'bad url' });
      }
      const symbol = (url.searchParams.get('symbol') ?? '').trim().replace(/^(sh|sz|bj)/i, '');
      if (!/^\d{6}$/.test(symbol)) return sendJson(res, 400, { ok: false, error: 'symbol 必须是 6 位数字代码' });
      try {
        const { facts, result } = await analyze(symbol);
        sendText(res, 200, renderReport(result.card, facts));
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  for (const r of routes) if (r.path && !ROUTE_PATHS.includes(r.path)) ROUTE_PATHS.push(r.path);
  return routes;
}

export function apply(ctx) {
  const logger = {
    warn: (msg) => {
      try {
        ctx.logger?.warn?.(msg);
      } catch {
        /* 日志失败不影响主流程 */
      }
    },
  };
  const routes = makeRoutes(logger, ctx);
  ctx.effect(
    () => {
      const disposers = routes.map((route) => ctx.webServer.register(route));
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* ignore */
          }
        }
      };
    },
    'tianshi: routes',
  );
}
