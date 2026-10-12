/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * ReDoS hardening for slash trimming (CodeQL js/polynomial-redos).
 *
 * `/\/+$/` and `/^\/+|\/+$/g` are catastrophic on V8: a long run of slashes with
 * a non-slash tail makes the anchored `+` backtrack O(n^2) (measured ~2783ms at
 * 80k slashes), and these ran on attacker-reachable request paths (router,
 * server pathname). They are replaced by rtrimSlashes/trimSlashes - a single
 * linear character scan. This test BITES: the pathological input below took
 * seconds on the old regex and must finish well under the bound now.
 *
 * Run with: npx tsx test/slashTrimReDoS.test.ts
 */
import { rtrimSlashes, trimSlashes } from "../packages/core/src/slashTrim.ts";

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean): void {
  if (condition) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${label}`); }
}

// ── Correctness (behaviour of the regexes they replace) ──
assert("rtrim strips only trailing", rtrimSlashes("//a//b//") === "//a//b");
assert("rtrim leaves inner + leading", rtrimSlashes("/x/") === "/x");
assert("trim strips both ends", trimSlashes("//a//b//") === "a//b");
assert("trim all-slashes -> empty", trimSlashes("////") === "");
assert("rtrim all-slashes -> empty", rtrimSlashes("////") === "");
assert("trim empty -> empty", trimSlashes("") === "");
assert("no slashes unchanged (identity)", trimSlashes("api/users") === "api/users");
assert("single segment", trimSlashes("/users/") === "users");

// ── Linearity (the DoS input) ──
const evil = "/".repeat(400_000) + "x"; // long slash run, non-slash tail
function underBound(fn: () => void): boolean {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 < 1000; // old regex: seconds
}
assert("rtrimSlashes stays linear on 400k slashes", underBound(() => rtrimSlashes(evil)));
assert("trimSlashes stays linear on 400k slashes", underBound(() => trimSlashes("x" + "/".repeat(400_000))));

console.log("\n==================================================");
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log("==================================================");
if (failed > 0) process.exit(1);
