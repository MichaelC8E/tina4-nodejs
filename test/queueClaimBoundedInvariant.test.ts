/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Queue-claim query is bounded — carbonah E003 regression (round 2b).
 *
 * The gallery queue consume and fail routes claim the next pending message
 * with `db.fetchOne(CLAIM_NEXT_PENDING_SQL, ...)`. Before this fix that SELECT
 * carried an `ORDER BY priority DESC, id ASC` and NO `LIMIT`, so SQLite sorted
 * the WHOLE pending backlog on every consume call before `fetchOne` read a
 * single row — an unbounded query on a hot path. `LIMIT 1` bounds it: one row
 * asked for, one row returned, the SAME row as before.
 *
 * This drives the REAL exported constant against a REAL node:sqlite database
 * through the REAL @tina4/orm Database facade — no mocks anywhere. SQLite is
 * the always-available primary engine, so this file never skips.
 *
 * Proven by mutation: strip the `LIMIT 1` from CLAIM_NEXT_PENDING_SQL and the
 * "bounded to a single row" pair goes red, while the "correct top row" data
 * invariant stays green — the bound is a new guarantee, the data is unchanged.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "@tina4/orm";
import { CLAIM_NEXT_PENDING_SQL } from "../packages/core/gallery/queue/src/lib/queueDb.ts";

// The unbounded shape the routes used to ship — the NEGATIVE control that
// proves the pending backlog is genuinely larger than one row, so a bounded
// result of exactly one is a real reduction and not an artefact of the data.
const UNBOUNDED_SQL =
  "SELECT * FROM tina4_queue WHERE topic = ? AND status = 'pending' AND available_at <= ? ORDER BY priority DESC, id ASC";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
  }
}

async function run(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "queue_claim_"));
  const db = await initDatabase({ type: "sqlite", path: join(dir, "claim.db") });

  try {
    await db.execute(`CREATE TABLE tina4_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      data TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      available_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      reserved_at TEXT
    )`);

    const past = "2026-01-01T00:00:00.000Z";
    const future = "2999-01-01T00:00:00.000Z";
    const ts = "2026-06-01T00:00:00.000Z"; // between past and future

    // id 1: claimable, lowest priority
    // id 2: claimable, TOP priority, oldest of the top-priority pair  -> the winner
    // id 3: claimable, TOP priority, but a higher id than 2           -> loses the tie
    // id 4: priority 9 but not yet available                          -> excluded by available_at
    // id 5: priority 9 but already completed                          -> excluded by status
    // id 6: priority 9 but a different topic                          -> excluded by topic
    const rows: [number, string, string, number, string][] = [
      [1, "gallery-tasks", "a", 0, past],
      [2, "gallery-tasks", "b", 5, past],
      [3, "gallery-tasks", "c", 5, past],
      [4, "gallery-tasks", "d", 9, future],
      [5, "gallery-tasks", "e", 9, past],
      [6, "other-topic", "f", 9, past],
    ];
    for (const [id, topic, data, priority, availableAt] of rows) {
      const status = id === 5 ? "completed" : "pending";
      await db.execute(
        "INSERT INTO tina4_queue (id, topic, data, status, priority, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id, topic, data, status, priority, availableAt, past]
      );
    }

    const params = ["gallery-tasks", ts];

    // ── data invariant: the bound must NOT change which row is claimed ─────────
    const claimed = await db.fetchOne<{ id: number; data: string; priority: number }>(
      CLAIM_NEXT_PENDING_SQL,
      params
    );
    assert(
      "claim returns the highest-priority, oldest pending row",
      claimed?.id === 2 && claimed?.data === "b" && claimed?.priority === 5,
      `got ${JSON.stringify(claimed)} — expected id 2 (priority 5, oldest of the tie)`
    );
    assert(
      "claim excludes future, completed and other-topic rows",
      claimed?.id !== 4 && claimed?.id !== 5 && claimed?.id !== 6 && claimed != null,
      `claimed id ${claimed?.id} slipped past the WHERE filter`
    );

    // ── bound guarantee: the shipped query carries LIMIT 1 (mutation gate) ────
    assert(
      "the shipped claim query is bounded with LIMIT 1",
      /\bLIMIT\s+1\b/i.test(CLAIM_NEXT_PENDING_SQL),
      `CLAIM_NEXT_PENDING_SQL has no LIMIT: ${CLAIM_NEXT_PENDING_SQL}`
    );

    // ── work bound: the engine yields exactly one row, not the whole backlog ──
    // fetchAll runs the SQL VERBATIM (no cap applied), so its row count is what
    // the engine actually produced. The bounded query yields 1; the old
    // unbounded shape yields the whole 3-row pending backlog for this topic.
    const boundedRows = await db.fetchAll(CLAIM_NEXT_PENDING_SQL, params);
    const unboundedRows = await db.fetchAll(UNBOUNDED_SQL, params);
    assert(
      "the bounded query materialises exactly one row",
      boundedRows.length === 1,
      `bounded query returned ${boundedRows.length} rows`
    );
    assert(
      "the old unbounded shape would materialise the whole pending backlog",
      unboundedRows.length === 3,
      `expected 3 pending claimable rows for the topic, got ${unboundedRows.length}`
    );
  } finally {
    await db.close?.();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("UNEXPECTED ERROR:", e);
  process.exit(1);
});
