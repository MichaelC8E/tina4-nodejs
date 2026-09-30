/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

import type { Tina4Response } from "./types.js";

/**
 * Relay a drained upstream (proxied) response to the client.
 *
 * The body is read to a string once, then returned as JSON when it parses and
 * as raw text with the upstream Content-Type otherwise, keeping the upstream
 * status either way. Shared by the dev-admin supervisor proxy and the feedback
 * agent proxy so both pass a backend response through identically.
 */
export async function relayUpstreamResponse(res: Tina4Response, upstream: Response): Promise<void> {
  const raw = await upstream.text();
  const status = upstream.status || 200;
  try {
    res.json(JSON.parse(raw), status);
  } catch {
    // Non-JSON upstream — pass through as text with the same status.
    res.raw.writeHead(status, {
      "Content-Type": upstream.headers.get("content-type") ?? "text/plain; charset=utf-8",
    });
    res.raw.end(raw);
  }
}
