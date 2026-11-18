// 开盘 · 共享排行榜后端 server.mjs（跨域补丁版）
// 来源：ChatGPT 生成的 kaipan-ranking/lib/server.mjs，仅改动跨域相关部分，
// 行情生成、交易结算、排名逻辑与原版完全一致。
// 用途：前端放在大陆可直连的域名（如 muse.ai 静态页）时，后端需允许该域名跨域调用，
// 否则浏览器会拦截 /api 响应，且 POST 会被原版的 Origin 检查拒绝（403）。
// 部署方式：用本文件替换 lib/server.mjs 后重新部署 Worker；
// 同时把前端 app.js 顶部的 API_BASE 填为本 Worker 的自定义域名（不要用 workers.dev）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- 真实行情：全市场股票清单（东财 f12 代码 / f13 市场 / f14 名称）----
// stocks.json 与本文件同目录；读不到时 STOCKS 为空，开局自动走随机生成兜底。
let STOCKS = [];
try { STOCKS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'stocks.json'), 'utf8')); } catch { STOCKS = []; }

// ---- 跨域配置：把前端页面的完整来源填进来，可填多个 ----
// 例如前端发布在 https://muse.ai/s/xxxx/... 时，来源就是 https://muse.ai
const ALLOWED_ORIGINS = new Set([
  'https://muse.ai',
  'https://bright-kestrel-30.github.io',
]);

export const OPEN = 266;
export function generate(seed, days) { let rng = seed; const random = () => { rng |= 0; rng = rng + 0x6D2B79F5 | 0; let t = Math.imul(rng ^ rng >>> 15, 1 | rng); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }; let p = 18 + random() * 22, drift = 0; return Array.from({ length: OPEN + days + 1 }, (_, i) => { if (i % 8 === 0) drift = (random() - .5) * .045; let o = p * (1 + (random() - .5) * .018), c = o * (1 + drift + (random() - .5) * .075); c = Math.max(p * .905, Math.min(p * 1.095, c)); let h = Math.max(o, c) * (1 + random() * .018), l = Math.min(o, c) * (1 - random() * .018); p = c; return { o, c, h, l, v: random() } }) }
const fee = v => Math.max(5, v * .0003);
export function initial() { return { cash: 100000, shares: 0, peak: 100000, drawdown: 0, trades: [], baseShares: 0, baseCash: 100000 } }
// 当天（北京时间）YYYYMMDD，供东财 K 线接口的 end 参数
const todayYmd = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
// 拉一只股票自 2023-01-01 以来的日 K 线（搜狐 hisHq，未复权），返回 [[日期,开,收,高,低,量], ...]（按日期升序）
// 搜狐返回倒序（最新在前），字段为 [日期,开,收,涨跌额,涨跌幅,最低,最高,量(手),额,换手率]
async function fetchStockKlines(code) {
  const url = `https://q.stock.sohu.com/hisHq?code=cn_${code}&start=20230101&end=${todayYmd()}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('sohu http ' + r.status);
  const d = await r.json();
  const hq = d?.[0]?.hq;
  if (!Array.isArray(hq) || !hq.length) throw new Error('sohu no data');
  return hq.reverse().map(k => [k[0], +k[1], +k[2], +k[6], +k[5], +k[7] * 100]);
}
// 先查 stock_bars 缓存，未命中再请求东财并存入缓存；请求失败时抛错
async function getStockBars(stock, db) {
  const [code, market, name] = stock;
  const row = await db.prepare('SELECT bars FROM stock_bars WHERE code=?').bind(code).first();
  if (row) return JSON.parse(row.bars);
  const bars = await fetchStockKlines(code);
  await db.prepare('INSERT INTO stock_bars(code,name,market,fetched_at,bars) VALUES(?,?,?,?,?)').bind(code, name, market, Date.now(), JSON.stringify(bars)).run();
  return bars;
}
// 从全市场随机抽一只股票、再随机抽一段历史，返回 {code,name,from,to,bars:[{o,c,h,l,v}]}
// 网络问题立即返回 null（走随机生成兜底）；上市太短则换下一只，最多 5 次
async function pickRealGame(days, db) {
  if (!STOCKS.length) return null;
  const need = OPEN + days + 1;
  for (let attempt = 0; attempt < 5; attempt++) {
    const stock = STOCKS[Math.floor(Math.random() * STOCKS.length)];
    let raw;
    try { raw = await getStockBars(stock, db); } catch { return null; }
    if (!raw || raw.length < need) continue;
    const start = Math.floor(Math.random() * (raw.length - need + 1));
    const win = raw.slice(start, start + need);
    let maxV = 0;
    for (const b of win) if (b[5] > maxV) maxV = b[5];
    return { code: stock[0], name: stock[2], from: win[0][0], to: win[win.length - 1][0], bars: win.map(b => ({ o: b[1], c: b[2], h: b[3], l: b[4], v: maxV ? b[5] / maxV : 0 })) };
  }
  return null;
}
export function step(state, bar, target, day) { const s = structuredClone(state); if (day === 1) { s.baseShares = Math.floor((100000 - 5) / (bar.o * 1.0003) / 100) * 100; s.baseCash = 100000 - s.baseShares * bar.o - fee(s.baseShares * bar.o) } if (target !== null) { const eq = s.cash + s.shares * bar.o; let wanted = target === 0 ? 0 : Math.floor((eq * target - (target === 1 ? 5 : 0)) / (bar.o * (target === 1 ? 1.0003 : 1)) / 100) * 100; let delta = wanted - s.shares; if (delta > 0) while (delta > 0 && delta * bar.o + fee(delta * bar.o) > s.cash) delta -= 100; if (delta) { const cost = fee(Math.abs(delta) * bar.o); s.cash -= delta * bar.o + cost; s.shares += delta; s.trades.push({ day, delta, price: bar.o, fee: cost }) } } const eq = s.cash + s.shares * bar.c; s.peak = Math.max(s.peak, eq); s.drawdown = Math.max(s.drawdown, 1 - eq / s.peak); return s }
const hash = async v => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))), x => x.toString(16).padStart(2, '0')).join('');
const ranked = `WITH best AS (SELECT s.*,p.name,ROW_NUMBER() OVER(PARTITION BY s.player ORDER BY s.ret DESC,s.dd ASC,s.finished ASC,s.id ASC) AS pick FROM sessions s JOIN players p ON p.id=s.player WHERE s.days=? AND s.finished IS NOT NULL), ranks AS (SELECT player,name,ret,dd,trades,finished,ROW_NUMBER() OVER(ORDER BY ret DESC,dd ASC,finished ASC,id ASC) AS rank FROM best WHERE pick=1)`;
function view(row) {
  const state = JSON.parse(row.state);
  const { real, ...trade } = state; // real.bars 绝不能进返回 JSON：只展开交易字段
  const finished = row.day === row.days;
  if (real) return { id: row.id, days: row.days, day: row.day, code: row.id.slice(0, 4).toUpperCase(), bars: real.bars.slice(0, OPEN + row.day + 1), ...trade, finished, realData: true, ...(finished ? { real: { name: real.name, code: real.code, from: real.from, to: real.to } } : {}) };
  const all = generate(row.seed, row.days);
  return { id: row.id, days: row.days, day: row.day, code: row.id.slice(0, 4).toUpperCase(), bars: all.slice(0, OPEN + row.day + 1), ...trade, finished };
}
export async function handle(req, env) {
  let cookie;
  const url = new URL(req.url);
  // ---- 跨域：只对白名单内的前端来源放行，带 Cookie 的跨域必须回具体来源，不能用 * ----
  const origin = req.headers.get('origin') || '';
  const corsOrigin = (origin && (origin === url.origin || ALLOWED_ORIGINS.has(origin))) ? origin : '';
  const corsHeaders = corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' } : {};
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...corsHeaders };
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...headers, ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
  try {
    const db = env.DB;
    // ---- 预检请求：浏览器跨域 POST 前会先发 OPTIONS，直接放行 ----
    // 允许 Authorization 头：前端在第三方 Cookie 被拦截时改用 Bearer Token 传递身份
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' } });
    if (!db) return reply({ error: '排行榜服务尚未配置' }, 503);
    // ---- 诊断接口：股票清单加载数 + 各候选数据源连通性（不含敏感信息）----
    if (url.pathname === '/api/health' && req.method === 'GET') {
      const probes = {
        sohu_kline: `https://q.stock.sohu.com/hisHq?code=cn_600519&start=20250101&end=${todayYmd()}`,
        eastmoney_kline: `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&klt=101&fqt=1&beg=20250101&end=${todayYmd()}&fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55,f56,f57`,
        eastmoney_list: 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f12&fs=m:0+t:6&fields=f12',
        sina: 'https://hq.sinajs.cn/list=sh600519',
        tencent: 'https://qt.gtimg.cn/q=ff_sh600519',
        github_raw: 'https://raw.githubusercontent.com/bright-kestrel-30/kaipan-backend/main/README.md',
      };
      const results = {};
      for (const [name, u] of Object.entries(probes)) {
        try {
          const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' }, signal: AbortSignal.timeout(6000) });
          if (!r.ok) results[name] = 'http_' + r.status;
          else { const t = await r.text(); results[name] = t.length > 20 ? 'ok' : 'empty'; }
        } catch (e) { results[name] = 'error:' + String((e && e.message) || e).slice(0, 80); }
      }
      return reply({ ok: true, stocks: STOCKS.length, probes: results });
    }
    if (req.method === 'POST') {
      // 原版：Origin 与本域不同即 403；补丁版：白名单内的前端来源也放行
      if (origin && origin !== url.origin && !ALLOWED_ORIGINS.has(origin)) return reply({ error: '请求来源不匹配' }, 403);
      if (!req.headers.get('content-type')?.startsWith('application/json')) return reply({ error: '需要 JSON 请求' }, 415);
    }
    // 身份凭证：优先读 HttpOnly Cookie；浏览器拦截第三方 Cookie 时，改读 Authorization: Bearer 头
    let token = req.headers.get('cookie')?.match(/(?:^|;\s*)kaipan_player=([a-f0-9]{64})(?:;|$)/)?.[1]
      || req.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    let player = token ? await db.prepare('SELECT id,name FROM players WHERE token=?').bind(await hash(token)).first() : null;
    if (!player) {
      if (url.pathname !== '/api/me') return reply({ error: '请先刷新页面建立玩家身份' }, 401);
      token = Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
      player = { id: crypto.randomUUID(), name: '玩家' + crypto.randomUUID().slice(0, 6).toUpperCase() };
      await db.prepare('INSERT INTO players(id,token,name,created) VALUES(?,?,?,?)').bind(player.id, await hash(token), player.name, Date.now()).run();
      // ---- 跨站 Cookie：跨域时必须 SameSite=None; Secure，否则浏览器不带回身份，换人 ----
      const crossSite = corsOrigin && corsOrigin !== url.origin;
      cookie = `kaipan_player=${token}; HttpOnly; SameSite=${crossSite ? 'None' : 'Lax'}; Path=/; Max-Age=31536000${url.protocol === 'https:' ? '; Secure' : ''}`;
    }
    let body = {};
    if (req.method === 'POST') { const raw = await req.text(); if (raw.length > 2048) return reply({ error: '请求过大' }, 413); try { body = JSON.parse(raw) } catch { return reply({ error: '请求格式不正确' }, 400) } }
    if (url.pathname === '/api/me') { if (req.method === 'POST') { const name = typeof body.name === 'string' ? body.name.trim() : ''; if ([...name].length < 1 || [...name].length > 16 || /[\x00-\x1f<>]/.test(name)) return reply({ error: '昵称需为 1–16 个字，请勿使用特殊符号' }, 400); await db.prepare('UPDATE players SET name=? WHERE id=?').bind(name, player.id).run(); player.name = name } return reply({ ...player, token }) }
    if (url.pathname === '/api/games' && req.method === 'POST') { const days = body.days; if (![34, 89, 144].includes(days)) return reply({ error: '训练周期不正确' }, 400); const id = crypto.randomUUID(), seed = crypto.getRandomValues(new Uint32Array(1))[0], now = Date.now(), stateObj = initial(); const real = await pickRealGame(days, db); if (real) stateObj.real = real; const state = JSON.stringify(stateObj); const res = await db.prepare('INSERT INTO sessions(id,player,days,day,seed,state,created) SELECT ?,?,?,0,?,?,? WHERE (SELECT COUNT(*) FROM sessions WHERE player=? AND created>?)<50').bind(id, player.id, days, seed, state, now, player.id, now - 86400000).run(); if (!res.meta.changes) return reply({ error: '今天已开局 50 次，请明天再来' }, 429); return reply(view({ id, days, day: 0, seed, state })) }
    const match = url.pathname.match(/^\/api\/games\/([a-f0-9-]{36})(\/step)?$/);
    if (match) { let row = await db.prepare('SELECT * FROM sessions WHERE id=? AND player=?').bind(match[1], player.id).first(); if (!row) return reply({ error: '这局不存在或不属于当前玩家' }, 404); if (req.method === 'POST' && match[2]) { if (![null, 0, 0.1, 0.5, 1].includes(body.target) || !Number.isInteger(body.day)) return reply({ error: '交易指令不正确' }, 400); if (row.day === body.day + 1) return reply(view(row)); if (row.day !== body.day || row.day === row.days) return reply({ error: '进度已更新，请重新载入这局' }, 409); const day = row.day + 1, st = JSON.parse(row.state), bar = st.real ? st.real.bars[OPEN + day] : generate(row.seed, row.days)[OPEN + day], s = step(st, bar, body.target, day), done = day === row.days; await db.prepare('UPDATE sessions SET day=?,state=?,finished=?,ret=?,dd=?,trades=? WHERE id=? AND day=?').bind(day, JSON.stringify(s), done ? Date.now() : null, done ? (s.cash + s.shares * bar.c) / 100000 - 1 : null, done ? s.drawdown : null, done ? s.trades.length : null, row.id, row.day).run(); row = await db.prepare('SELECT * FROM sessions WHERE id=?').bind(row.id).first() } return reply(view(row)) }
    if (url.pathname === '/api/leaderboard' && req.method === 'GET') { const days = Number(url.searchParams.get('days')); if (![34, 89, 144].includes(days)) return reply({ error: '周期不正确' }, 400); const rows = await db.prepare(ranked + ' SELECT * FROM ranks ORDER BY rank LIMIT 50').bind(days).all(); const mine = await db.prepare(ranked + ' SELECT * FROM ranks WHERE player=?').bind(days, player.id).first(); const totals = await db.prepare('SELECT days,COUNT(DISTINCT player) AS players,COUNT(*) AS games FROM sessions WHERE finished IS NOT NULL GROUP BY days').all(); return reply({ rows: rows.results.map(r => ({ ...r, mine: r.player === player.id, player: undefined })), mine: mine ? { ...mine, player: undefined } : null, totals: totals.results }) }
    return reply({ error: '接口不存在' }, 404);
  } catch (e) { console.error('API failure', e.message); return reply({ error: '服务暂时繁忙，请稍后重试。你的进度会保留。' }, 500) }
}
