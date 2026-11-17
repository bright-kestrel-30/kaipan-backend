# 开盘 · 共享排行榜后端（Node.js 版）

把 Cloudflare Worker 版（`server-cors-patched.mjs`）移植为纯 Node.js 服务，
供 Abasthan 等没有 D1 的 PaaS 部署。游戏逻辑、跨域逻辑与 Worker 版完全一致，
前端 API 约定不变。

## 文件

- `server.mjs`：后端逻辑（Worker 版原样复制，未改动）。行情生成、交易结算、排名、
  跨域白名单（`https://muse.ai`）都在这里。
- `db.mjs`：D1 兼容适配器。用 Node.js 24 内置 `node:sqlite` 实现
  `prepare().bind().first() / .all() / .run()`，建库时按迁移 SQL 建 `players`、
  `sessions` 两张表及索引（幂等）。
- `index.mjs`：HTTP 入口。只处理 `/api/*`，其余路径返回 404 JSON。
- `package.json`：`type: module`，`npm start` = `node index.mjs`，**无任何第三方依赖**。

## 启动

```bash
node index.mjs
# 或
npm start
```

启动时打印监听地址，例如 `kaipan backend listening on http://0.0.0.0:3000`。

环境变量：

- `PORT`：监听端口，默认 `3000`（Abasthan 等 PaaS 会注入 PORT，按其值监听）。
- `HOST`：监听地址，默认 `0.0.0.0`。
- `KAIPAN_DB`：SQLite 数据库文件路径，默认 `./data/kaipan.db`。
  注意：Abasthan 免费实例的文件系统重启后可能不保留数据，如需长期保存排行榜，
  请确认平台是否提供持久化磁盘，或改用平台提供的数据库。

## API（与 Worker 版一致）

- `GET /api/me`：建立/读取玩家身份（首次调用返回玩家并 `Set-Cookie: kaipan_player=...`）。
- `POST /api/me`：`{ "name": "昵称" }`，1–16 字，改昵称。
- `POST /api/games`：`{ "days": 34 | 89 | 144 }`，开一局（每玩家每天最多 50 局）。
- `GET /api/games/:id`：读取/续玩一局。
- `POST /api/games/:id/step`：`{ "day": N, "target": null | 0 | 0.1 | 0.5 | 1 }`，推进一天。
- `GET /api/leaderboard?days=34`：前 50 名 + 自己的名次（`mine`）+ 各周期统计（`totals`）。
- 跨域：白名单来源（目前只有 `https://muse.ai`）可跨域调用并携带 Cookie；
  前端把 `app.js` 顶部的 `API_BASE` 填为本服务的公网地址即可。

## 本地验证

```bash
node --check server.mjs db.mjs index.mjs
PORT=3456 KAIPAN_DB=/tmp/kaipan-test.db node index.mjs
curl -s -c /tmp/c.txt http://localhost:3456/api/me
curl -s -b /tmp/c.txt -X POST -H 'Content-Type: application/json' -d '{"days":34}' http://localhost:3456/api/games
curl -s -b /tmp/c.txt 'http://localhost:3456/api/leaderboard?days=34'
```
