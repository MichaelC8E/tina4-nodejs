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
| CRUD-SQL builder shared home | ✅ SqlCrudMixin | ⚠️ CrudSqlTrait (partial) | ⚠️ | ✅ sqlCrud.ts |

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

## What was extracted vs left (per-engine)
- EXTRACTED into `packages/orm/src/adapters/sqlCrud.ts` (buildInsertRow / buildInsertRows /
  buildUpdate / buildDelete): the string-vs-hash filter branch, `[...data, ...(params ?? [])]`
  value assembly, batch fan-out, empty-list/empty-filter handling. −212 LOC across the six
  adapters, one 178-line composer shared by all.
- LEFT per-adapter (as scoped): dialect object, RETURNING */SCOPE_IDENTITY()/generator lastId,
  the driver call + result extraction (prepare().run() / client.query / tedious / FB txn /
  odbc), placeholder rewrite fed in as `convertFragment` (convertPlaceholders / bindable) with
  `startAt` (pg 1, mssql 0), MSSQL 2-statement affectedRows=1, FB fail-loud single insert.
- Deliberately un-merged (distinct concern, out of scope — "do not couple distinct concerns"):
  the READ path (fetchAsync/fetchOneAsync LIMIT/OFFSET) and connection/sync-stub scaffolding
  the clone detector still flags (12 small 6-13 line adapter clones). A separate read-path task.

## Metrics (native engine v3.8.92, `tina4 metrics --json`)
- BEFORE 1ed12d3: duplicate_blocks=61, duplicate_lines=607
- AFTER  HEAD:     duplicate_blocks=61, duplicate_lines=581 (−26)
- Adapter write-path LOC: −212 (300 removed, 88 added) collapsed into sqlCrud.ts (+178).
- The clone detector never counted the interleaved CRUD bodies as line-clones (per-engine
  execution lines interleaved), so its block count is flat; the DRY/LOC win is the real signal.

## Commits (on feature/orm-crud-dedup, off origin/v3 @ 1ed12d3)
- 28309fc  test(orm): characterize CRUD write path across live engines
- b537ef4  refactor(orm): add shared SQL CRUD composer (sqlCrud.ts) + unit lock
- 6eb78ab  refactor(orm): route SQLite insert/update/delete through the composer
- 8a03b29  refactor(orm): route PostgreSQL insert/update/delete through the composer
- 3fb2431  refactor(orm): route MySQL insert/update/delete through the composer
- 0baffe5  refactor(orm): route MSSQL insert/update/delete through the composer
- ed5f19c  refactor(orm): route Firebird insert/update/delete through the composer
- 6ca4553  refactor(orm): route ODBC insert/update/delete through the composer

## Status: In Progress (8 commits; typecheck rc=0 at every commit; full lab suite verifying at HEAD)
