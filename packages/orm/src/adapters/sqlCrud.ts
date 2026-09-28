/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * One CRUD write composer for every SQL engine, instead of one per adapter.
 *
 * `sqlDialect.ts` already collapsed the SQL *fragment* builders (columns, the
 * SET list, the WHERE list). What it did NOT collapse was the METHOD BODIES:
 * every SQL adapter's `insert`/`update`/`delete` re-implemented the SAME
 * envelope around those fragments — the string-filter branch vs the hash-filter
 * branch, the `[...Object.values(data), ...(params ?? [])]` value assembly, the
 * batch fan-out — differing only in the two things a `Dialect` already captures
 * (identifier quoting, parameter marker) plus three per-engine knobs:
 *
 *   INSERT SUFFIX     "" | " RETURNING *" | "; SELECT SCOPE_IDENTITY() AS id"
 *   MARKER START      1 (PostgreSQL $N) | 0 (MSSQL @pN) | ignored (`?` engines)
 *   FRAGMENT REWRITE  a raw "id = ?" WHERE string: identity on a `?` engine,
 *                     convertPlaceholders/bindable on a positional one
 *
 * This is the Node port of the Python master's `SqlCrudMixin`
 * (tina4_python/database/adapter.py): build the SQL and the ordered parameter
 * list engine-neutrally from a dialect + those knobs, and hand the pair back to
 * the adapter to EXECUTE.
 *
 * Like `sqlDialect.ts`, these functions build STRINGS and parameter arrays and
 * NOTHING else. Execution and result extraction stay in the adapters on purpose:
 * `this.db.prepare().run()` vs `await this.client!.query()` vs tedious vs a
 * Firebird transaction handle, and RETURNING / SCOPE_IDENTITY() / lastId /
 * affectedRows normalisation, are genuinely per-driver — folding them in here
 * would trade a real duplication for a fake abstraction.
 *
 * MongoDB has no entry: it does not build SQL at all.
 */

import { type Dialect, buildInsert, buildSetClause, buildWhereClause } from "./sqlDialect.js";

/** A composed statement: the SQL text and its ordered parameter list. */
export interface CrudSql {
  sql: string;
  values: unknown[];
}

/**
 * A composed batch INSERT: one SQL statement plus one parameter row per input
 * record, ready for the adapter's own `executeMany`.
 */
export interface CrudBatchSql {
  sql: string;
  paramsList: unknown[][];
}

/** The only per-engine differences in a composed write's SQL + parameter list. */
export interface WriteOptions {
  /**
   * 1-based position of the FIRST parameter marker. PostgreSQL numbers `$N`
   * from 1; MSSQL names `@pN` from 0 and BINDS by that name, so the start must
   * match its binding loop. Engines whose marker is `?` ignore it. Default 1.
   */
  startAt?: number;
  /**
   * Rewrite a raw string WHERE fragment's `?` markers for this engine, given the
   * 1-based position of the fragment's first marker. `?` engines leave it
   * untouched (the default); a positional engine passes its `convertPlaceholders`
   * / `bindable`. Only ever applied to the developer-supplied string filter,
   * never to the framework-built hash WHERE.
   */
  convertFragment?: (fragment: string, startAt: number) => string;
}

const identityFragment = (fragment: string): string => fragment;

/**
 * A single-row INSERT: `INSERT INTO t (a, b) VALUES (?, ?)<suffix>` and the row's
 * values in column order. `suffix` carries the genuinely engine-specific tail
 * (PostgreSQL's ` RETURNING *`, MSSQL's SCOPE_IDENTITY() probe).
 */
export function buildInsertRow(
  dialect: Dialect,
  table: string,
  data: Record<string, unknown>,
  suffix = "",
  options: WriteOptions = {},
): CrudSql {
  const keys = Object.keys(data);
  const sql = buildInsert(dialect, table, keys, suffix, options.startAt ?? 1);
  return { sql, values: Object.values(data) };
}

/**
 * A batch INSERT from a list of rows — one parameterised statement the adapter
 * runs once per row via its own `executeMany`. Returns `null` for an empty list
 * (the adapters treat that as a no-op affecting zero rows). The keys come from
 * the first row, exactly as every adapter already assumed.
 */
export function buildInsertRows(
  dialect: Dialect,
  table: string,
  rows: Record<string, unknown>[],
): CrudBatchSql | null {
  if (rows.length === 0) return null;
  const keys = Object.keys(rows[0]);
  const sql = buildInsert(dialect, table, keys);
  const paramsList = rows.map((row) => keys.map((k) => row[k]));
  return { sql, paramsList };
}

/**
 * An UPDATE from a data object and either a hash filter (`{id: 5}` →
 * `WHERE "id" = ?`) or a raw string filter (`"id = ?"` + `params`). The SET
 * values always lead the parameter list; the WHERE values follow.
 */
export function buildUpdate(
  dialect: Dialect,
  table: string,
  data: Record<string, unknown>,
  filter: Record<string, unknown> | string,
  params?: unknown[],
  options: WriteOptions = {},
): CrudSql {
  const startAt = options.startAt ?? 1;
  const convertFragment = options.convertFragment ?? identityFragment;
  const dataKeys = Object.keys(data);
  const setClauses = buildSetClause(dialect, dataKeys, startAt);
  const whereStart = startAt + dataKeys.length;

  if (typeof filter === "string") {
    const where = filter ? ` WHERE ${convertFragment(filter, whereStart)}` : "";
    return {
      sql: `UPDATE ${dialect.quote(table)} SET ${setClauses}${where}`,
      values: [...Object.values(data), ...(params ?? [])],
    };
  }

  const whereClauses = buildWhereClause(dialect, Object.keys(filter), whereStart);
  return {
    sql: `UPDATE ${dialect.quote(table)} SET ${setClauses} WHERE ${whereClauses}`,
    values: [...Object.values(data), ...Object.values(filter)],
  };
}

/**
 * A DELETE from either a hash filter (`{id: 5}` → `WHERE "id" = ?`) or a raw
 * string filter (`"age < ?"` + `params`). An empty string filter deletes the
 * whole table (the explicit `truncate()` spelling routes through here).
 *
 * The array-of-dicts filter form is NOT handled here: only SQLite and ODBC
 * accept it, and both loop it into per-row `delete` calls that land back in one
 * of the two branches above — that fan-out stays in those two adapters.
 */
export function buildDelete(
  dialect: Dialect,
  table: string,
  filter: Record<string, unknown> | string,
  params?: unknown[],
  options: WriteOptions = {},
): CrudSql {
  const startAt = options.startAt ?? 1;
  const convertFragment = options.convertFragment ?? identityFragment;

  if (typeof filter === "string") {
    const where = filter ? ` WHERE ${convertFragment(filter, startAt)}` : "";
    return {
      sql: `DELETE FROM ${dialect.quote(table)}${where}`,
      values: params ?? [],
    };
  }

  const whereClauses = buildWhereClause(dialect, Object.keys(filter), startAt);
  return {
    sql: `DELETE FROM ${dialect.quote(table)} WHERE ${whereClauses}`,
    values: Object.values(filter),
  };
}
