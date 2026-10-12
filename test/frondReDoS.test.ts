/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Frond ReDoS hardening (CodeQL js/polynomial-redos).
 *
 * The lexer used backtracking regexes with lazy `[\s\S]*?` bodies, and the
 * whitespace/base64url helpers used `/\s+$/` and `/=+$/`. On V8 those are
 * genuinely catastrophic — a crafted ~8KB template value hung the event loop
 * for ~100s. The lexer is now an index-based forward scan, and the helpers use
 * native trims and a bounded quantifier. These tests BITE: the pathological
 * inputs below ran for tens of seconds on the old code, so a regression that
 * reintroduces the backtracking blows the time bound. Correctness of the
 * rewrite is pinned alongside, since those are the cases a bad rewrite breaks.
 *
 * Run with: npx tsx test/frondReDoS.test.ts
 */
import { Frond } from "../packages/frond/src/index.ts";

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean): void {
  if (condition) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${label}`); }
}

const f = new Frond("/nonexistent");

// A generous bound: the linear scan finishes these in single-digit ms; the old
// backtracking took tens of seconds, so 2000ms cleanly separates them without
// flaking on a slow CI box.
const BOUND_MS = 2000;
function rendersUnderBound(src: string): boolean {
  const t0 = process.hrtime.bigint();
  try { f.renderString(src, {}); } catch { /* a malformed template may throw; the point is it returns fast */ }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return ms < BOUND_MS;
}

// ── Linearity (the DoS inputs: many openers with no closer) ──
assert("{% x n times stays linear",   rendersUnderBound("{%".repeat(200_000)));
assert("{{ x n times stays linear",   rendersUnderBound("{{".repeat(200_000)));
assert("{# x n times stays linear",   rendersUnderBound("{#".repeat(200_000)));
assert("{% raw %} x n with no endraw", rendersUnderBound("{% raw %}".repeat(60_000)));
assert("mixed openers stay linear",   rendersUnderBound("{% {{ {# ".repeat(60_000)));

// ── Lexer correctness (what a bad index-scan rewrite would break) ──
// An opener with no closer is literal TEXT, not a tag.
assert("unclosed {% is literal text", f.renderString("a {% b c", {}) === "a {% b c");
assert("unclosed {{ is literal text", f.renderString("a {{ b c", {}) === "a {{ b c");
// A '{' that starts no tag stays in text.
assert("bare brace stays", f.renderString("a { b } c", {}) === "a { b } c");
// First-closer wins (lazy-equivalent), inner delimiters swallowed.
assert("var takes first }}", f.renderString("{{ n }} }}", { n: "X" }) === "X }}");
// Comments are stripped.
assert("comment stripped", f.renderString("a{# hidden #}b", {}) === "ab");
// Whitespace control still trims (the trimEnd/trimStart path that replaced /\s+$/).
assert("whitespace control -%} trims after", f.renderString("a {%- if x -%} b {%- endif -%} c", { x: true }) === "abc");
assert("whitespace control {{- -}} trims", f.renderString("a   {{- n -}}   b", { n: "X" }) === "aXb");

// ── Raw blocks (index-scan extraction) ──
assert("raw keeps literal template syntax", f.renderString("{% raw %}{{ not_a_var }}{% endraw %}", {}) === "{{ not_a_var }}");
assert("raw with dashes", f.renderString("x{%- raw -%}{{ a }}{%- endraw -%}y", {}) === "x{{ a }}y");
assert("raw then real var", f.renderString("{% raw %}{{lit}}{% endraw %} {{ n }}", { n: "X" }) === "{{lit}} X");
// An unterminated raw opener falls through to normal tokenizing (no crash, no hang).
assert("unterminated raw renders", rendersUnderBound("{% raw %}" + "x".repeat(100_000)));

// ── base64url helper (/=+$/ -> /={1,2}$/): form_token round-trips cleanly ──
// form_token renders a hidden <input>; the JWT lives in its value="…" attribute.
const tokEl = f.renderString("{{ form_token('login') }}", {});
const jwt = (tokEl.match(/value="([^"]+)"/) || [])[1] || "";
assert("form_token emits a 3-part JWT", jwt.split(".").length === 3);
assert("JWT base64url segments carry no '=' padding", jwt.length > 0 && !jwt.includes("="));

console.log("\n==================================================");
console.log(`  Results: ${passed === 0 && failed === 0 ? "none" : ""}\x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log("==================================================");
if (failed > 0) process.exit(1);
