// 开盘 · 共享排行榜后端 server.mjs（跨域补丁版）
// 来源：ChatGPT 生成的 kaipan-ranking/lib/server.mjs，仅改动跨域相关部分，
// 行情生成、交易结算、排名逻辑与原版完全一致。
// 用途：前端放在大陆可直连的域名（如 muse.ai 静态页）时，后端需允许该域名跨域调用，
// 否则浏览器会拦截 /api 响应，且 POST 会被原版的 Origin 检查拒绝（403）。
// 部署方式：用本文件替换 lib/server.mjs 后重新部署 Worker；
// 同时把前端 app.js 顶部的 API_BASE 填为本 Worker 的自定义域名（不要用 workers.dev）。

// ---- 跨域配置：把前端页面的完整来源填进来，可填多个 ----
// 例如前端发布在 https://muse.ai/s/xxxx/... 时，来源就是 https://muse.ai
const ALLOWED_ORIGINS = new Set([
  'https://muse.ai',
]);

export const OPEN = 266;
export function generate(seed, days) { let rng = seed; const random = () => { rng |= 0; rng = rng + 0x6D2B79F5 | 0; let t = Math.imul(rng ^ rng >>> 15, 1 | rng); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }; let p = 18 + random() * 22, drift = 0; return Array.from({ length: OPEN + days + 1 }, (_, i) => { if (i % 8 === 0) drift = (random() - .5) * .045; let o = p * (1 + (random() - .5) * .018), c = o * (1 + drift + (random() - .5) * .075); c = Math.max(p * .905, Math.min(p * 1.095, c)); let h = Math.max(o, c) * (1 + random() * .018), l = Math.min(o, c) * (1 - random() * .018); p = c; return { o, c, h, l, v: random() } }) }
const fee = v => Math.max(5, v * .0003);
export function initial() { return { cash: 100000, shares: 0, peak: 100000, drawdown: 0, trades: [], baseShares: 0, baseCash: 100000 } }
export function step(state, bar, target, day) { const s = structuredClone(state); if (day === 1) { s.baseShares = Math.floor((100000 - 5) / (bar.o * 1.0003) / 100) * 100; s.baseCash = 100000 - s.baseShares * bar.o - fee(s.baseShares * bar.o) } if (target !== null) { const eq = s.cash + s.shares * bar.o; let wanted = target === 0 ? 0 : Math.floor((eq * target - (target === 1 ? 5 : 0)) / (bar.o * (target === 1 ? 1.0003 : 1)) / 100) * 100; let delta = wanted - s.shares; if (delta > 0) while (delta > 0 && delta * bar.o + fee(delta * bar.o) > s.cash) delta -= 100; if (delta) { const cost = fee(Math.abs(delta) * bar.o); s.cash -= delta * bar.o + cost; s.shares += delta; s.trades.push({ day, delta, price: bar.o, fee: cost }) } } const eq = s.cash + s.shares * bar.c; s.peak = Math.max(s.peak, eq); s.drawdown = Math.max(s.drawdown, 1 - eq / s.peak); return s }
const hash = async v => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))), x => x.toString(16).padStart(2, '0')).join('');
const ranked = `WITH best AS (SELECT s.*,p.name,ROW_NUMBER() OVER(PARTITION BY s.player ORDER BY s.ret DESC,s.dd ASC,s.finished ASC,s.id ASC) AS pick FROM sessions s JOIN players p ON p.id=s.player WHERE s.days=? AND s.finished IS NOT NULL), ranks AS (SELECT player,name,ret,dd,trades,finished,ROW_NUMBER() OVER(ORDER BY ret DESC,dd ASC,finished ASC,id ASC) AS rank FROM best WHERE pick=1)`;
function view(row) { const all = generate(row.seed, row.days); return { id: row.id, days: row.days, day: row.day, code: row.id.slice(0, 4).toUpperCase(), bars: all.slice(0, OPEN + row.day + 1), ...JSON.parse(row.state), finished: row.day === row.days } }
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
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
    if (!db) return reply({ error: '排行榜服务尚未配置' }, 503);
    if (req.method === 'POST') {
      // 原版：Origin 与本域不同即 403；补丁版：白名单内的前端来源也放行
      if (origin && origin !== url.origin && !ALLOWED_ORIGINS.has(origin)) return reply({ error: '请求来源不匹配' }, 403);
      if (!req.headers.get('content-type')?.startsWith('application/json')) return reply({ error: '需要 JSON 请求' }, 415);
    }
    let token = req.headers.get('cookie')?.match(/(?:^|;\s*)kaipan_player=([a-f0-9]{64})(?:;|$)/)?.[1];
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
    if (url.pathname === '/api/me') { if (req.method === 'POST') { const name = typeof body.name === 'string' ? body.name.trim() : ''; if ([...name].length < 1 || [...name].length > 16 || /[\x00-\x1f<>]/.test(name)) return reply({ error: '昵称需为 1–16 个字，请勿使用特殊符号' }, 400); await db.prepare('UPDATE players SET name=? WHERE id=?').bind(name, player.id).run(); player.name = name } return reply(player) }
    if (url.pathname === '/api/games' && req.method === 'POST') { const days = body.days; if (![34, 89, 144].includes(days)) return reply({ error: '训练周期不正确' }, 400); const id = crypto.randomUUID(), seed = crypto.getRandomValues(new Uint32Array(1))[0], now = Date.now(), state = JSON.stringify(initial()); const res = await db.prepare('INSERT INTO sessions(id,player,days,day,seed,state,created) SELECT ?,?,?,0,?,?,? WHERE (SELECT COUNT(*) FROM sessions WHERE player=? AND created>?)<50').bind(id, player.id, days, seed, state, now, player.id, now - 86400000).run(); if (!res.meta.changes) return reply({ error: '今天已开局 50 次，请明天再来' }, 429); return reply(view({ id, days, day: 0, seed, state })) }
    const match = url.pathname.match(/^\/api\/games\/([a-f0-9-]{36})(\/step)?$/);
    if (match) { let row = await db.prepare('SELECT * FROM sessions WHERE id=? AND player=?').bind(match[1], player.id).first(); if (!row) return reply({ error: '这局不存在或不属于当前玩家' }, 404); if (req.method === 'POST' && match[2]) { if (![null, 0, 0.1, 0.5, 1].includes(body.target) || !Number.isInteger(body.day)) return reply({ error: '交易指令不正确' }, 400); if (row.day === body.day + 1) return reply(view(row)); if (row.day !== body.day || row.day === row.days) return reply({ error: '进度已更新，请重新载入这局' }, 409); const day = row.day + 1, bar = generate(row.seed, row.days)[OPEN + day], s = step(JSON.parse(row.state), bar, body.target, day), done = day === row.days; await db.prepare('UPDATE sessions SET day=?,state=?,finished=?,ret=?,dd=?,trades=? WHERE id=? AND day=?').bind(day, JSON.stringify(s), done ? Date.now() : null, done ? (s.cash + s.shares * bar.c) / 100000 - 1 : null, done ? s.drawdown : null, done ? s.trades.length : null, row.id, row.day).run(); row = await db.prepare('SELECT * FROM sessions WHERE id=?').bind(row.id).first() } return reply(view(row)) }
    if (url.pathname === '/api/leaderboard' && req.method === 'GET') { const days = Number(url.searchParams.get('days')); if (![34, 89, 144].includes(days)) return reply({ error: '周期不正确' }, 400); const rows = await db.prepare(ranked + ' SELECT * FROM ranks ORDER BY rank LIMIT 50').bind(days).all(); const mine = await db.prepare(ranked + ' SELECT * FROM ranks WHERE player=?').bind(days, player.id).first(); const totals = await db.prepare('SELECT days,COUNT(DISTINCT player) AS players,COUNT(*) AS games FROM sessions WHERE finished IS NOT NULL GROUP BY days').all(); return reply({ rows: rows.results.map(r => ({ ...r, mine: r.player === player.id, player: undefined })), mine: mine ? { ...mine, player: undefined } : null, totals: totals.results }) }
    return reply({ error: '接口不存在' }, 404);
  } catch (e) { console.error('API failure', e.message); return reply({ error: '服务暂时繁忙，请稍后重试。你的进度会保留。' }, 500) }
}
