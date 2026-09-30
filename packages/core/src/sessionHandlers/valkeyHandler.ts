/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Tina4 Valkey Session Handler — Valkey (Redis-compatible) via raw TCP, zero dependencies.
 *
 * Same as the Redis handler but uses VALKEY-prefixed configuration variables.
 * Valkey is a Redis-compatible key-value store fork.
 *
 * Configure via environment variables:
 *   TINA4_SESSION_VALKEY_HOST     (default: "127.0.0.1")
 *   TINA4_SESSION_VALKEY_PORT     (default: 6379)
 *   TINA4_SESSION_VALKEY_PASSWORD (optional)
 *   TINA4_SESSION_VALKEY_PREFIX   (default: "tina4:session:")
 *   TINA4_SESSION_VALKEY_DB       (default: 0)
 */
import { RespSessionHandler } from "./respSessionHandler.js";

export interface ValkeySessionConfig {
  host?: string;
  port?: number;
  password?: string;
  prefix?: string;
  db?: number;
  // Unified SessionConfig fields are tolerated (and ignored) so the central
  // Session can forward its config object without a structural mismatch.
  backend?: string;
  path?: string;
  ttl?: number;
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
  redisPrefix?: string;
  redisDb?: number;
}

/**
 * Valkey session handler using raw TCP (RESP protocol).
 *
 * Uses synchronous socket communication — no external Valkey/Redis client required.
 * Stores session data as JSON strings with Valkey TTL for automatic expiry.
 *
 * Valkey uses the same RESP protocol as Redis, so this handler is functionally
 * identical to RedisSessionHandler but with VALKEY config variable names.
 */
export class ValkeySessionHandler extends RespSessionHandler {
  constructor(config?: ValkeySessionConfig) {
    super(
      {
        host: config?.host
          ?? process.env.TINA4_SESSION_VALKEY_HOST
          ?? "127.0.0.1",
        port: config?.port
          ?? (process.env.TINA4_SESSION_VALKEY_PORT
            ? parseInt(process.env.TINA4_SESSION_VALKEY_PORT, 10)
            : 6379),
        password: config?.password
          ?? process.env.TINA4_SESSION_VALKEY_PASSWORD
          ?? "",
        prefix: config?.prefix
          ?? process.env.TINA4_SESSION_VALKEY_PREFIX
          ?? "tina4:session:",
        db: config?.db
          ?? (process.env.TINA4_SESSION_VALKEY_DB
            ? parseInt(process.env.TINA4_SESSION_VALKEY_DB, 10)
            : 0),
      },
      "Valkey",
    );
  }
}
