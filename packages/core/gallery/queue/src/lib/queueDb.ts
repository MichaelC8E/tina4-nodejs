/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/** Shared SQLite database helper for the queue gallery demo. */
import type { DatabaseAdapter } from "tina4-nodejs/orm";

let _db: DatabaseAdapter | null = null;

export const MAX_RETRIES = 3;

export async function getQueueDb(): Promise<DatabaseAdapter> {
  if (_db) return _db;
  const orm = await import("tina4-nodejs/orm");
  _db = await orm.initDatabase({ type: "sqlite", path: "./data/gallery_queue.db" });
  try {
    _db.execute(`CREATE TABLE IF NOT EXISTS tina4_queue (
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
  } catch (_e) { /* table already exists */ }
  return _db;
}

export function now(): string {
  return new Date().toISOString();
}

/**
 * Claim the next pending message for a topic — highest priority first, then
 * the oldest (lowest id). The `LIMIT 1` bounds the work: without it SQLite
 * sorts the WHOLE pending backlog on every consume call before `fetchOne`
 * reads a single row (carbonah E003, an unbounded query on a hot path). One
 * row asked for, one row returned. Shared by the consume and fail routes so
 * the claim query lives in exactly one place.
 */
export const CLAIM_NEXT_PENDING_SQL =
  "SELECT * FROM tina4_queue WHERE topic = ? AND status = 'pending' AND available_at <= ? ORDER BY priority DESC, id ASC LIMIT 1";
