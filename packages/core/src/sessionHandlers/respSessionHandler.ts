/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Tina4 RESP Session Handler base — the shared store logic behind Redis and
 * Valkey, zero dependencies.
 *
 * Redis and Valkey speak the same RESP protocol, so the read/write/destroy
 * transport is byte-for-byte identical between them — only the configuration
 * variable names and the log label differ. That difference lives entirely in
 * each subclass constructor; everything the session store actually DOES lives
 * here, once. A subclass resolves its own host/port/password/prefix/db from
 * config or environment, then hands a {@link RespConnection} plus a label to
 * `super()`.
 */
import type { SessionHandler } from "../session.js";
import { respCommandSync } from "./respClient.js";

interface SessionData {
  _created: number;
  _accessed: number;
  [key: string]: unknown;
}

/** Resolved connection details a RESP session handler needs. */
export interface RespConnection {
  host: string;
  port: number;
  password: string;
  prefix: string;
  db: number;
}

/**
 * RESP (Redis/Valkey) session handler using raw TCP — no external client.
 *
 * Stores session data as JSON strings with a server-side TTL for automatic
 * expiry. A genuine key miss yields `null`; a transport/connection FAILURE
 * (server unreachable, rejected AUTH, timeout) THROWS so the Session boundary
 * can tell "not found" (silent) from "backend failed" (log-loud + degrade).
 */
export abstract class RespSessionHandler implements SessionHandler {
  protected constructor(
    private readonly conn: RespConnection,
    private readonly label: string,
  ) {}

  /**
   * Execute a RESP command synchronously against the live server.
   *
   * Delegates to the shared {@link respCommandSync} transport: a genuine key
   * miss yields `""`, and a transport/connection FAILURE THROWS so the caller
   * can distinguish "not found" from "backend failed". Backend-failure parity.
   */
  private execSync(args: string[]): string {
    return respCommandSync(
      { host: this.conn.host, port: this.conn.port, password: this.conn.password, db: this.conn.db },
      args,
      this.label,
    );
  }

  private key(sessionId: string): string {
    return `${this.conn.prefix}${sessionId}`;
  }

  read(sessionId: string): SessionData | null {
    const raw = this.execSync(["GET", this.key(sessionId)]);
    if (!raw) return null;     // key miss — normal "no session yet", NOT an error
    try {
      return JSON.parse(raw) as SessionData;
    } catch {
      return null;
    }
  }

  write(sessionId: string, data: SessionData, ttl: number = 0): void {
    const json = JSON.stringify(data);
    if (ttl > 0) {
      this.execSync(["SETEX", this.key(sessionId), String(ttl), json]);
    } else {
      this.execSync(["SET", this.key(sessionId), json]);
    }
  }

  destroy(sessionId: string): void {
    this.execSync(["DEL", this.key(sessionId)]);
  }
}
