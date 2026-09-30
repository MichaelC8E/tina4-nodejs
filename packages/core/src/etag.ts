/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Does an `If-None-Match` header match the response ETag?
 *
 * The header may be `*`, a single tag, or a comma-separated list; the `W/`
 * weak prefix is stripped on both sides before comparing (RFC 7232 §2.3.2
 * weak comparison). Shared by the static file server and the compression
 * interceptor so both answer 304 the same way.
 */
export function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const strip = (tag: string) => tag.trim().replace(/^W\//, "");
  const target = strip(etag);
  return ifNoneMatch.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === "*" || strip(trimmed) === target;
  });
}
