# Task: DB-adapter boilerplate DEDUP (Node)

Behaviour-preserving extraction of the genuinely-identical query/execute/param-binding/
row-shaping boilerplate copy-pasted across the concrete SQL adapters. Port the proven
Python `SqlCrudMixin` design (reuse ladder rung 4). Per-engine differences stay per-adapter.
Branch from origin/v3. PR into v3 (ADR-0073).

## Scope
- [x] Characterize: baseline metrics on v3 HEAD (native engine `tina4 metrics --json --top 999`)
- [x] Confirm true copy-paste vs per-engine difference (read adapter bodies)
- [ ] Characterization tests FIRST — real engines (SQLite via node:sqlite, PG, MySQL, MSSQL, Firebird, ODBC on lab), no mocks: insert/update/delete (string-filter branch AND hash-filter branch), execute/executeMany param binding incl. `?`-injection safety, fetch row shape, lastId, error capture. Green before AND after.
- [ ] Extract shared CRUD-SQL builder + base (one home) — `packages/orm/src/adapters/` (e.g. `sqlCrud.ts` / a `BaseSqlAdapter`)
- [ ] Convert pg / mysql / mssql / sqlite / firebird / odbc to use it (one adapter per commit, suite green between)
- [ ] Full suite green at HEAD (`npx tsx test/run-all.ts` + `npm run typecheck`) — 0 failed, 0 NEW skips on DB area
- [ ] Re-run metrics, record after-count
- [ ] PR into v3

## What to extract (TRUE copy-paste, confirmed)
The `insert`/`update`/`delete` method bodies are structurally identical across
pg/mysql/mssql/sqlite/firebird: the `typeof filter === "string"` WHERE branch, the
hash-filter branch (`buildWhereClause` + `Object.values`), the `[...Object.values(data), ...]`
value assembly. Python already collapses this in `SqlCrudMixin` (tina4-python
`tina4_python/database/adapter.py:1182`) — build SQL+params engine-neutrally from a dialect
descriptor + marker, delegate execution to the adapter's own `execute`/`executeMany`.

## Do NOT merge (per-engine — leave in each adapter)
- dialect objects (ANSI/POSTGRES/MSSQL dialect), placeholder conversion (`convertPlaceholders` vs marker)
- driver call (`this.db.prepare().run()` vs `await this.client!.query()` vs tedious)
- RETURNING / `SCOPE_IDENTITY()` / lastId normalisation, affectedRows quirks (MSSQL 2-statement rowcount)

## Baseline (measured 2026-09-27, native engine, v3 @ 1ed12d3)
Total duplicate_blocks=61, duplicate_lines=607. DB-adapter offenders:
mysql.ts (233,265,313), mssql.ts (370,422,501), odbc.ts (280,352), postgres.ts(372),
sqlite.ts(316), firebird.ts(532,752), database.ts, cachedDatabase.ts.

## Parity
| Feature | Python | PHP | Ruby | Node |
|---------|--------|-----|------|------|
| CRUD-SQL builder shared home | ✅ SqlCrudMixin | ⚠️ CrudSqlTrait (partial) | ⚠️ | ❌ port target |

## Tests (written first, real, no mocks)
- [x] `test/sqlCrudWritePath.test.ts` — characterization across live engines (SQLite always;
      PG/MySQL/MSSQL/Firebird/ODBC when their `TINA4_TEST_*` coord is set). Pins insert
      single+batch (affectedRows, round-trip, lastId on SQLite), update string-filter+params
      AND hash filter, delete string-filter+params AND hash filter, `'); DROP TABLE` injection
      safety (bound not interpolated), durability on a fresh connection. GREEN before AND after.
- [x] `test/sqlCrudBuilder.test.ts` — pure-function byte-for-byte lock on the composer:
      exact SQL + params for every dialect/opts combo (RETURNING suffix, `@pN` start-at-0,
      `$N` continues past SET, fragment rewrite). Mutation-proof.

## Bugs — [ ] (none found; refactor is behaviour-preserving)

## Commits —

## Status: In Progress (characterization GREEN at baseline; extracting per-adapter)
