// index.mjs — 开盘共享排行榜后端，Node.js HTTP 入口
// 启动：node index.mjs（或 npm start）
//   环境变量 PORT（默认 3000）、HOST（默认 0.0.0.0）、KAIPAN_DB（数据库文件，默认 ./data/kaipan.db）
// 行为：
//   - 只处理 /api/*，其余路径返回 404 JSON。
//   - 把 Node 请求转成 Fetch Request 调 server.mjs 的 handle(req, { DB })，
//     再把返回的 Response（状态码、headers、body）原样写回客户端。
//   - 游戏逻辑、跨域白名单（https://muse.ai）都在 server.mjs 里，本文件不碰。

import http from 'node:http';
import { createDB } from './db.mjs';
import { handle } from './server.mjs';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DB = createDB();

// 转发给 Request 时去掉逐跳头（让 undici 按 body 重新算 content-length 等）
const HOP_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
    if (!url.pathname.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '接口不存在' }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_HEADERS.has(k.toLowerCase())) continue;
      if (Array.isArray(v)) for (const item of v) headers.append(k, item);
      else headers.set(k, v);
    }

    const request = new Request(url.toString(), {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : rawBody,
    });

    const response = await handle(request, { DB });
    const text = await response.text();

    const outHeaders = {};
    for (const [k, v] of response.headers.entries()) {
      if (k.toLowerCase() === 'set-cookie') continue; // 下面用 getSetCookie() 单独处理，避免合并丢失
      outHeaders[k] = v;
    }
    const setCookie = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
    if (setCookie.length) outHeaders['set-cookie'] = setCookie;

    res.writeHead(response.status, outHeaders);
    res.end(text);
  } catch (e) {
    console.error('HTTP error', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '服务暂时繁忙，请稍后重试。' }));
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`kaipan backend listening on http://${HOST}:${PORT}`);
});
