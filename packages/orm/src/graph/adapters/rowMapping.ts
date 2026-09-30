/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Shared driver-row mapping for the Cypher/GQL graph adapters (Bolt, Ultipa).
 *
 * Both drivers return a flat record with the same reserved column names —
 * `id`, `labels`, `props`, `type`, `f`, `t` — because both adapters run the
 * same `RETURN ... AS id, ... AS props` projection. Turning such a row into an
 * engine-neutral GraphNode or GraphEdge is therefore identical work, so it
 * lives here once rather than in each adapter.
 */
import { GraphNode, GraphEdge } from "../shapes.js";

/** A flat driver record from a Cypher/GQL `RETURN ... AS <col>` projection. */
export interface DriverRow {
  id?: unknown;
  labels?: unknown;
  props?: unknown;
  type?: unknown;
  f?: unknown;
  t?: unknown;
  [key: string]: unknown;
}

/** Message of an error value, whether or not it is a real Error. */
export function errorMessage(exc: unknown): string {
  if (exc instanceof Error) return exc.message;
  return String(exc);
}

/** Build an engine-neutral GraphNode from a driver row, or null when there is none. */
export function nodeFromRow(row: DriverRow | undefined | null): GraphNode | null {
  if (row === null || row === undefined) return null;
  return new GraphNode(
    String(row.id),
    (row.labels as string[]) ?? [],
    (row.props as Record<string, unknown>) ?? {},
  );
}

/** Build an engine-neutral GraphEdge from a driver row, or null when there is none. */
export function edgeFromRow(row: DriverRow | undefined | null): GraphEdge | null {
  if (row === null || row === undefined) return null;
  return new GraphEdge(
    String(row.id),
    String(row.type),
    String(row.f),
    String(row.t),
    (row.props as Record<string, unknown>) ?? {},
  );
}
