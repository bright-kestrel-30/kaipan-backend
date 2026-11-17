// db.mjs — D1 兼容适配器（Node.js 24 内置 node:sqlite）
// 用法：
//   import { createDB } from './db.mjs';
//   const DB = createDB(); // 默认 ./data/kaipan.db，可用环境变量 KAIPAN_DB 覆盖
//   await DB.prepare('SELECT * FROM players WHERE id=?').bind(id).first();
//   await DB.prepare('SELECT ...').all();        // -> { results: [...] }
//   await DB.prepare('INSERT ...').bind(...).run(); // -> { meta: { changes: N } }
//
// 语义与 Cloudflare D1 保持一致：
//   - prepare(sql) 返回带 bind(...params) 的对象；bind 后提供 first() / all() / run()。
//   - 为兼容 server.mjs 里一处不调用 bind() 直接 .all() 的写法，
//     prepare() 返回的对象本身也带 first() / all() / run()（等价于 bind() 无参）。
//   - first() 无行时返回 null（D1 同款），all() 返回 { results }，run() 返回 { meta: { changes } }。
//   - 建库时若表/索引不存在，按 drizzle 迁移建表并建索引（幂等，可重复启动）。

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// 与 drizzle/0000_chilly_the_watchers.sql 完全一致的建表语句
// （players、sessions 两张表及索引；语句分隔符 --> statement-breakpoint 是 drizzle 的标记）
const MIGRATION = `
CREATE TABLE \`players\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`token\` text NOT NULL,
	\`name\` text NOT NULL,
	\`created\` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`players_token_unique\` ON \`players\` (\`token\`);
--> statement-breakpoint
CREATE TABLE \`sessions\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`player\` text NOT NULL,
	\`days\` integer NOT NULL,
	\`day\` integer NOT NULL,
	\`seed\` integer NOT NULL,
	\`state\` text NOT NULL,
	\`created\` integer NOT NULL,
	\`finished\` integer,
	\`ret\` real,
	\`dd\` real,
	\`trades\` integer,
	FOREIGN KEY (\`player\`) REFERENCES \`players\`(\`id\`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX \`sessions_player\` ON \`sessions\` (\`player\`,\`created\`);
--> statement-breakpoint
CREATE INDEX \`sessions_rank\` ON \`sessions\` (\`days\`,\`ret\`,\`dd\`);
`;

function initSchema(db) {
  for (const chunk of MIGRATION.split('--> statement-breakpoint')) {
    const sql = chunk.trim();
    if (!sql) continue;
    // 做成幂等：重复启动时表/索引已存在也不报错
    const idempotent = sql
      .replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ')
      .replace(/^CREATE UNIQUE INDEX /i, 'CREATE UNIQUE INDEX IF NOT EXISTS ')
      .replace(/^CREATE INDEX /i, 'CREATE INDEX IF NOT EXISTS ');
    db.exec(idempotent);
  }
}

export function createDB(dbPath) {
  const path = resolve(dbPath || process.env.KAIPAN_DB || './data/kaipan.db');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  initSchema(db);
  return {
    prepare(sql) {
      const st = db.prepare(sql);
      const bound = (params) => ({
        first() {
          const row = st.get(...params);
          return row === undefined ? null : row;
        },
        all() {
          return { results: st.all(...params) };
        },
        run() {
          const info = st.run(...params);
          return { meta: { changes: info.changes } };
        },
      });
      const self = bound([]);
      return { ...self, bind: (...params) => bound(params) };
    },
    close() {
      db.close();
    },
  };
}
