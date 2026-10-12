/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

// ReDoS-safe slash trimming.
//
// `/\/+$/` and `/^\/+|\/+$/g` are polynomial on V8: a long run of slashes
// followed by a non-slash tail makes the anchored `+` backtrack O(n^2), so a
// crafted request path of ~80k slashes hangs the event loop for seconds. These
// run on attacker-reachable paths (the router, the server pathname), so the fix
// matters. A single forward/backward character scan strips the same slashes in
// one linear pass with no backtracking.

const SLASH = 47; // '/'.charCodeAt(0)

/** Strip trailing '/' characters (linear; the ReDoS-safe `/\/+$/` replacement). */
export function rtrimSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === SLASH) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** Strip leading AND trailing '/' (the ReDoS-safe `/^\/+|\/+$/g` replacement). */
export function trimSlashes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === SLASH) start++;
  while (end > start && s.charCodeAt(end - 1) === SLASH) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}
