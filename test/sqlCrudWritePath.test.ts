/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Characterization of the CRUD write path against EVERY live SQL engine, the
 * safety net for the shared-composer extraction (packages/orm/src/adapters/
 * sqlCrud.ts). It pins the OBSERVABLE contract the extraction must preserve
 * byte-for-byte — same rows, same affectedRows, same parameter binding — so it
 * is GREEN before the extraction and GREEN after.
 *
 * For each engine it drives the PUBLIC Database facade -> the concrete adapter's
 * insert / update / delete / fetch, no mocks, reading durability back on a
 * FRESH connection:
 *
 *   - insert (single) round-trips a row and reports affectedRows = 1
 *   - insert (batch, list of rows) reports affectedRows = the row count
 *   - update with a HASH filter ({id: n}) changes exactly that row
 *   - update with a STRING filter + params ("id = ?", [n]) changes the same row
 *     — the case the pre-3.13.94 adapters mis-walked with Object.keys()
 *   - delete with a HASH filter removes exactly that row
 *   - delete with a STRING filter + params removes the matching rows
 *   - PARAM BINDING / INJECTION SAFETY: a value containing `'); DROP TABLE ...`
 *     is bound as data, not interpolated — it round-trips verbatim and the table
 *     survives
 *   - SQLite also pins lastId on an AUTOINCREMENT insert (per-engine lastId is
 *     covered by the *ProviderContract tests)
 *
 * SQLite always runs. PostgreSQL / MySQL / MSSQL / Firebird / ODBC run when their
 * TINA4_TEST_*_URL coordinate is set; unset, each emits a `[needs:X]` skip the
 * central gate excuses only on an environment that never promised the engine
 * (test/_serviceGate.ts). The lab sets every coordinate, so every engine runs.
 *
 * Run with: npx tsx test/sqlCrudWritePath.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Database, createAdapterFromUrl } from "../packages/orm/src/index.js";

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass++;
    console.log(`    \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`    \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
  }
}

// A missing coordinate is a tagged skip the central gate excuses only where the
// engine was never promised (never on the lab, which sets every coordinate).
function skipEngine(engine: string, tag: string): void {
  console.log(`  \x1b[33mSKIP\x1b[0m ${engine} write-path characterization [needs:${tag}]`);
}

const INJECTION = "robert'); DROP TABLE crudchar; --";

interface EngineCase {
  name: string;
  tag: string;
  url: () => string | undefined;
  table: string;
  /** DDL for a (id INTEGER PK, label VARCHAR) table — autoincrement not needed. */
  createSql: (table: string) => string;
  /** true on engines that support AUTOINCREMENT so lastId can be pinned. */
  autoincrement?: boolean;
}

const ENGINES: EngineCase[] = [
  {
    name: "sqlite",
    tag: "sqlite",
    url: () => undefined, // handled specially (temp file), never skipped
    table: "crudchar_sqlite",
    createSql: (t) => `CREATE TABLE ${t} (id INTEGER PRIMARY KEY, label VARCHAR(200))`,
    autoincrement: true,
  },
  {
    name: "postgres",
    tag: "postgres",
    url: () => process.env.TINA4_TEST_PG_URL,
    table: "crudchar_pg",
    createSql: (t) => `CREATE TABLE ${t} (id INTEGER PRIMARY KEY, label VARCHAR(200))`,
  },
  {
    name: "mysql",
    tag: "mysql",
    url: () => process.env.TINA4_TEST_MYSQL_URL,
    table: "crudchar_mysql",
    createSql: (t) => `CREATE TABLE ${t} (id INTEGER NOT NULL, label VARCHAR(200), PRIMARY KEY(id))`,
  },
  {
    name: "mssql",
    tag: "mssql",
    url: () => process.env.TINA4_TEST_MSSQL_URL,
    table: "crudchar_mssql",
    createSql: (t) => `CREATE TABLE ${t} (id INTEGER NOT NULL, label VARCHAR(200), PRIMARY KEY(id))`,
  },
  {
    name: "firebird",
    tag: "firebird",
    url: () => process.env.TINA4_TEST_FIREBIRD_URL,
    table: "crudchar_fb",
    createSql: (t) => `CREATE TABLE ${t} (id INTEGER NOT NULL, label VARCHAR(200), PRIMARY KEY(id))`,
  },
  {
    name: "odbc",
    tag: "postgres", // the lab DSN points ODBC at PostgreSQL
    url: () => process.env.TINA4_TEST_ODBC_DSN && `odbc:///${process.env.TINA4_TEST_ODBC_DSN}`,
    table: "crudchar_odbc",
    createSql: (t) => `CREATE TABLE ${t} (id INTEGER PRIMARY KEY, label VARCHAR(200))`,
  },
];

async function connect(url: string): Promise<Database> {
  const adapter: any = await createAdapterFromUrl(url);
  return new Database(adapter);
}

async function dropQuietly(db: Database, table: string): Promise<void> {
  try {
    await db.execute(`DROP TABLE ${table}`);
  } catch {
    /* first run — table absent */
  }
}

async function runMatrix(engine: EngineCase, url: string): Promise<void> {
  const t = engine.table;
  const db = await connect(url);
  try {
    await dropQuietly(db, t);
    await db.execute(engine.createSql(t));

    // insert (single) — round-trip + affectedRows
    const ins = await db.insert(t, { id: 1, label: "alpha" });
    check(`${engine.name}: insert single affectedRows=1`, ins.affectedRows === 1, JSON.stringify(ins));
    let row = await db.fetchOne<{ label: string }>(`SELECT label FROM ${t} WHERE id = ?`, [1]);
    check(`${engine.name}: insert single round-trips`, row?.label === "alpha", JSON.stringify(row));

    // insert (batch)
    const batch = await db.insert(t, [{ id: 2, label: "beta" }, { id: 3, label: "gamma" }]);
    check(`${engine.name}: insert batch affectedRows=2`, batch.affectedRows === 2, JSON.stringify(batch));

    // update (hash filter)
    const uHash = await db.update(t, { label: "ALPHA" }, { id: 1 });
    check(`${engine.name}: update hash affectedRows=1`, uHash.affectedRows === 1, JSON.stringify(uHash));
    row = await db.fetchOne(`SELECT label FROM ${t} WHERE id = ?`, [1]);
    check(`${engine.name}: update hash applied`, row?.label === "ALPHA", JSON.stringify(row));

    // update (string filter + params) — the Object.keys() footgun case
    const uStr = await db.update(t, { label: "BETA" }, "id = ?", [2]);
    check(`${engine.name}: update string-filter affectedRows=1`, uStr.affectedRows === 1, JSON.stringify(uStr));
    row = await db.fetchOne(`SELECT label FROM ${t} WHERE id = ?`, [2]);
    check(`${engine.name}: update string-filter applied`, row?.label === "BETA", JSON.stringify(row));

    // injection safety — the payload is bound as data, not interpolated
    const uInj = await db.update(t, { label: INJECTION }, "id = ?", [3]);
    check(`${engine.name}: injection update affectedRows=1`, uInj.affectedRows === 1, JSON.stringify(uInj));
    row = await db.fetchOne(`SELECT label FROM ${t} WHERE id = ?`, [3]);
    check(`${engine.name}: injection payload round-trips verbatim`, row?.label === INJECTION, JSON.stringify(row));
    const survives = await db.fetchOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`);
    check(`${engine.name}: table survived injection (3 rows)`, Number(survives?.n) === 3, JSON.stringify(survives));

    // delete (hash filter)
    const dHash = await db.delete(t, { id: 1 });
    check(`${engine.name}: delete hash affectedRows=1`, dHash.affectedRows === 1, JSON.stringify(dHash));

    // delete (string filter + params)
    const dStr = await db.delete(t, "id = ?", [2]);
    check(`${engine.name}: delete string-filter affectedRows=1`, dStr.affectedRows === 1, JSON.stringify(dStr));

    // durability on a FRESH connection: only id=3 remains
    const fresh = await connect(url);
    try {
      const remaining = await fresh.fetch(`SELECT id FROM ${t} ORDER BY id`);
      const ids = remaining.records.map((r: any) => Number(r.id));
      check(`${engine.name}: durable — only id=3 remains`, JSON.stringify(ids) === JSON.stringify([3]), JSON.stringify(ids));
    } finally {
      fresh.close();
    }

    await dropQuietly(db, t);
  } finally {
    db.close();
  }
}

async function runSqlite(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "crudchar-sqlite-"));
  const url = `sqlite:///${join(dir, "crud.db")}`;
  try {
    await runMatrix(ENGINES[0], url);
    // lastId on an AUTOINCREMENT table — representative; per-engine lastId lives
    // in the *ProviderContract tests.
    const db = await connect(url);
    try {
      await db.execute("CREATE TABLE crudchar_auto (id INTEGER PRIMARY KEY AUTOINCREMENT, label VARCHAR(200))");
      await db.insert("crudchar_auto", { label: "first" });
      const r2 = await db.insert("crudchar_auto", { label: "second" });
      check("sqlite: lastId reflects the autoincrement row", Number(r2.lastId) === 2, JSON.stringify(r2));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("SQL CRUD write-path characterization (real engines, no mocks)\n");

  console.log("  sqlite:");
  await runSqlite();

  for (const engine of ENGINES.slice(1)) {
    const url = engine.url();
    if (!url) {
      skipEngine(engine.name, engine.tag);
      continue;
    }
    console.log(`  ${engine.name}:`);
    await runMatrix(engine, url);
  }

  console.log(`\nsqlCrudWritePath: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

await main();
