/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Byte-for-byte lock on the shared SQL CRUD composer (packages/orm/src/adapters/
 * sqlCrud.ts). These are PURE functions over their inputs — no database, no
 * double — so this is a plain unit test, not a mock test.
 *
 * It pins the EXACT SQL string and parameter array each engine's insert/update/
 * delete used to build inline in its adapter, per the six adapters as they stood
 * before the extraction:
 *
 *   SQLite/ODBC   ANSI quotes, `?` markers, no suffix
 *   PostgreSQL    ANSI quotes, `$N` markers from 1, INSERT ... RETURNING *
 *   MySQL         backtick quotes, `?` markers
 *   MSSQL         [bracket] quotes, `@pN` markers from 0, "; SELECT SCOPE_IDENTITY() AS id"
 *   Firebird      fbQuote (upper-cased), `?` markers
 *
 * Mutation-proof: change any emitted marker start, suffix, or the SET/WHERE
 * numbering and the matching case goes RED. The real engines then re-prove the
 * same composition end-to-end in sqlCrudWritePath.test.ts.
 *
 * Run with: npx tsx test/sqlCrudBuilder.test.ts
 */

import {
  ANSI_DIALECT,
  MSSQL_DIALECT,
  MYSQL_DIALECT,
  POSTGRES_DIALECT,
  firebirdDialect,
  quoteIdentifierWith,
} from "../packages/orm/src/adapters/sqlDialect.js";
import {
  buildDelete,
  buildInsertRow,
  buildInsertRows,
  buildUpdate,
} from "../packages/orm/src/adapters/sqlCrud.js";

let pass = 0;
let fail = 0;

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n       expected ${e}\n       actual   ${a}`);
  }
}

// Firebird's dialect quotes upper-case (an unquoted identifier is folded up).
const fbQuote = (name: string): string => quoteIdentifierWith(name, '"', '"', true);
const FB_DIALECT = firebirdDialect(fbQuote);

// ---------------------------------------------------------------- INSERT (single)
eq("sqlite insert single", buildInsertRow(ANSI_DIALECT, "t", { a: 1, b: 2 }), {
  sql: 'INSERT INTO "t" ("a", "b") VALUES (?, ?)',
  values: [1, 2],
});
eq("postgres insert single RETURNING *", buildInsertRow(POSTGRES_DIALECT, "t", { a: 1, b: 2 }, " RETURNING *"), {
  sql: 'INSERT INTO "t" ("a", "b") VALUES ($1, $2) RETURNING *',
  values: [1, 2],
});
eq("mysql insert single", buildInsertRow(MYSQL_DIALECT, "t", { a: 1, b: 2 }), {
  sql: "INSERT INTO `t` (`a`, `b`) VALUES (?, ?)",
  values: [1, 2],
});
eq(
  "mssql insert single SCOPE_IDENTITY startAt 0",
  buildInsertRow(MSSQL_DIALECT, "t", { a: 1, b: 2 }, "; SELECT SCOPE_IDENTITY() AS id", { startAt: 0 }),
  {
    sql: "INSERT INTO [t] ([a], [b]) VALUES (@p0, @p1); SELECT SCOPE_IDENTITY() AS id",
    values: [1, 2],
  },
);
eq("firebird insert single (upper-cased quotes)", buildInsertRow(FB_DIALECT, "t", { id: 1, name: "x" }), {
  sql: 'INSERT INTO "T" ("ID", "NAME") VALUES (?, ?)',
  values: [1, "x"],
});

// ---------------------------------------------------------------- INSERT (batch)
eq("sqlite insert batch", buildInsertRows(ANSI_DIALECT, "t", [{ a: 1, b: 2 }, { a: 3, b: 4 }]), {
  sql: 'INSERT INTO "t" ("a", "b") VALUES (?, ?)',
  paramsList: [[1, 2], [3, 4]],
});
eq(
  "mssql insert batch uses `?` markers (ANSI marker, MSSQL quote)",
  buildInsertRows({ quote: MSSQL_DIALECT.quote, marker: ANSI_DIALECT.marker }, "t", [{ a: 1 }, { a: 2 }]),
  { sql: "INSERT INTO [t] ([a]) VALUES (?)", paramsList: [[1], [2]] },
);
eq("insert batch empty -> null", buildInsertRows(ANSI_DIALECT, "t", []), null);

// ---------------------------------------------------------------- UPDATE (hash filter)
eq("sqlite update hash", buildUpdate(ANSI_DIALECT, "t", { name: "x" }, { id: 5 }), {
  sql: 'UPDATE "t" SET "name" = ? WHERE "id" = ?',
  values: ["x", 5],
});
eq(
  "postgres update hash ($N continues past SET)",
  buildUpdate(POSTGRES_DIALECT, "t", { name: "x", age: 9 }, { id: 5 }),
  { sql: 'UPDATE "t" SET "name" = $1, "age" = $2 WHERE "id" = $3', values: ["x", 9, 5] },
);
eq(
  "mssql update hash (@pN from 0, continues past SET)",
  buildUpdate(MSSQL_DIALECT, "t", { name: "x", age: 9 }, { id: 5 }, undefined, { startAt: 0 }),
  { sql: "UPDATE [t] SET [name] = @p0, [age] = @p1 WHERE [id] = @p2", values: ["x", 9, 5] },
);
eq("mysql update hash", buildUpdate(MYSQL_DIALECT, "t", { name: "x" }, { id: 5 }), {
  sql: "UPDATE `t` SET `name` = ? WHERE `id` = ?",
  values: ["x", 5],
});

// ---------------------------------------------------------------- UPDATE (string filter + params)
eq("sqlite update string filter", buildUpdate(ANSI_DIALECT, "t", { name: "x" }, "id = ?", [5]), {
  sql: 'UPDATE "t" SET "name" = ? WHERE id = ?',
  values: ["x", 5],
});
eq(
  "postgres update string filter (convertFragment rewrites ? -> $N from whereStart)",
  buildUpdate(POSTGRES_DIALECT, "t", { name: "x" }, "id = ?", [5], {
    convertFragment: (frag, start) => frag.replace(/\?/g, () => `$${start}`),
  }),
  { sql: 'UPDATE "t" SET "name" = $1 WHERE id = $2', values: ["x", 5] },
);
eq("update empty string filter -> no WHERE", buildUpdate(ANSI_DIALECT, "t", { name: "x" }, ""), {
  sql: 'UPDATE "t" SET "name" = ?',
  values: ["x"],
});

// ---------------------------------------------------------------- DELETE (hash filter)
eq("sqlite delete hash", buildDelete(ANSI_DIALECT, "t", { id: 5 }), {
  sql: 'DELETE FROM "t" WHERE "id" = ?',
  values: [5],
});
eq("mysql delete hash", buildDelete(MYSQL_DIALECT, "t", { id: 5 }), {
  sql: "DELETE FROM `t` WHERE `id` = ?",
  values: [5],
});
eq("postgres delete hash ($N from 1)", buildDelete(POSTGRES_DIALECT, "t", { id: 5, kind: "a" }), {
  sql: 'DELETE FROM "t" WHERE "id" = $1 AND "kind" = $2',
  values: [5, "a"],
});
eq(
  "mssql delete hash (@pN from 0)",
  buildDelete(MSSQL_DIALECT, "t", { id: 5, kind: "a" }, undefined, { startAt: 0 }),
  { sql: "DELETE FROM [t] WHERE [id] = @p0 AND [kind] = @p1", values: [5, "a"] },
);

// ---------------------------------------------------------------- DELETE (string filter + params)
eq("sqlite delete string filter", buildDelete(ANSI_DIALECT, "t", "age < ?", [18]), {
  sql: 'DELETE FROM "t" WHERE age < ?',
  values: [18],
});
eq("delete empty string filter -> whole table", buildDelete(ANSI_DIALECT, "t", ""), {
  sql: 'DELETE FROM "t"',
  values: [],
});
eq(
  "mssql delete string filter via bindable (convertFragment ignores start)",
  buildDelete(MSSQL_DIALECT, "t", "1 = 1", [], { convertFragment: (frag) => frag }),
  { sql: "DELETE FROM [t] WHERE 1 = 1", values: [] },
);

console.log(`\nsqlCrudBuilder: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
