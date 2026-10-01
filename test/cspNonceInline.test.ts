/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * The framework's own inline content runs under the strict default CSP (ADR-0088).
 *
 * The framework serves `default-src 'self'` by default. A browser refuses every
 * inline <style>/<script> under that policy unless the element carries a nonce
 * the Content-Security-Policy header also names. So the framework mints one nonce
 * per response, injects `'nonce-<X>'` into style-src AND script-src, and stamps
 * the SAME value on every inline <style>/<script> it emits. It also de-inlines
 * every style="..." and onclick= attribute, because a nonce covers a <style>/
 * <script> ELEMENT but never an attribute.
 *
 * NO MOCKS: a real @tina4/core server booted with startServer over real HTTP.
 * The welcome page at "/" (a project with no "/" route and no static index) is
 * the page the reported fresh-init bug rendered unstyled; the crash route drives
 * the dev error overlay; a 404 drives an error twig.
 *
 * Mirrors tina4-python/tests/test_csp_nonce_inline.py.
 *
 * Run with: npx tsx test/cspNonceInline.test.ts
 */
import { startServer } from "../packages/core/src/index.ts";
import http from "node:http";
import os from "node:os";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { freePort } from "./freePort.ts";

const TEST_DIR = mkdtempSync(join(os.tmpdir(), "tina4-csp-nonce-"));
const PORT = await freePort();
let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

/** GET path, resolving the FULL response (headers AND body together) so a single
 * response proves the header nonce and the body's inline tags agree. */
function get(path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: PORT, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function cspNonce(csp: string | undefined): string | null {
  const m = /'nonce-([^']+)'/.exec(String(csp));
  return m ? m[1] : null;
}

/** Every inline <style>/<script> (not <script src=...>) in `html` carries `nonce`. */
function everyInlineTagCarries(html: string, nonce: string): boolean {
  const styles = [...html.matchAll(/<style\b([^>]*)>/gi)].map((m) => m[1]);
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
  if (styles.length === 0 && scripts.length === 0) return true; // vacuously clean
  for (const attrs of styles) if (!attrs.includes(`nonce="${nonce}"`)) return false;
  for (const attrs of scripts) {
    if (attrs.includes("src=")) continue; // external script needs no nonce
    if (!attrs.includes(`nonce="${nonce}"`)) return false;
  }
  return true;
}

// A project with NO "/" route and NO static index, so GET / falls through to the
// framework's own welcome page. Plus a route that throws (dev error overlay).
mkdirSync(join(TEST_DIR, "src/routes/api/ping"), { recursive: true });
mkdirSync(join(TEST_DIR, "src/routes/crash"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(join(TEST_DIR, "src/routes/api/ping/get.ts"),
  `export default async function (_req: any, res: any) { return res.json({ ok: true }); }\n`);
writeFileSync(join(TEST_DIR, "src/routes/crash/get.ts"),
  `export default async function () { throw new Error("boom: KeyError-like crash for the overlay"); }\n`);

process.env.TINA4_RATE_LIMIT = "100000";
process.env.TINA4_DEBUG = "true";          // landing page + error overlay are dev-only
process.env.TINA4_NO_BROWSER = "true";
process.env.TINA4_OVERRIDE_CLIENT = "true";
delete process.env.TINA4_CSP;

console.log("=== CSP nonce for framework inline content (ADR-0088) ===\n");

const server = await startServer({ port: PORT, basePath: TEST_DIR });

try {
  // --- The welcome page at "/" ---
  const welcome = await get("/");
  const csp = welcome.headers["content-security-policy"] as string | undefined;
  const nonce = cspNonce(csp);

  assert("welcome: served (200)", welcome.status === 200, `status=${welcome.status}`);
  assert("welcome: CSP has default-src 'self'", String(csp).includes("default-src 'self'"), String(csp));
  assert("welcome: style-src carries a nonce", /style-src[^;]*'nonce-/.test(String(csp)), String(csp));
  assert("welcome: script-src carries a nonce", /script-src[^;]*'nonce-/.test(String(csp)), String(csp));
  assert("welcome: CSP never uses unsafe-inline", !String(csp).includes("'unsafe-inline'"), String(csp));
  assert("welcome: body has an inline <style> and <script>",
    /<style\b/i.test(welcome.body) && /<script\b/i.test(welcome.body));
  assert("welcome: every inline <style>/<script> carries the header nonce",
    !!nonce && everyInlineTagCarries(welcome.body, nonce),
    `nonce=${nonce}`);
  assert("welcome: emits NO inline style= attribute", !welcome.body.includes('style="'),
    "framework welcome page still emits a style= attribute");
  assert("welcome: emits NO inline onclick= handler", !welcome.body.includes("onclick="),
    "framework welcome page still emits an inline onclick handler");

  // --- Per-response nonce: two requests never share one ---
  const second = await get("/");
  const n2 = cspNonce(second.headers["content-security-policy"] as string | undefined);
  assert("each response gets a distinct nonce", !!nonce && !!n2 && nonce !== n2, `n1=${nonce} n2=${n2}`);

  // --- The dev error overlay (a route that throws) ---
  const overlay = await get("/crash");
  const overlayNonce = cspNonce(overlay.headers["content-security-policy"] as string | undefined);
  assert("error overlay: status 500", overlay.status === 500, `status=${overlay.status}`);
  assert("error overlay: body is the rich overlay", overlay.body.includes("Tina4 Debug Overlay"),
    overlay.body.slice(0, 120));
  assert("error overlay: every inline <style>/<script> carries the header nonce",
    !!overlayNonce && everyInlineTagCarries(overlay.body, overlayNonce), `nonce=${overlayNonce}`);
  assert("error overlay: emits NO inline style= attribute", !overlay.body.includes('style="'),
    "error overlay still emits a style= attribute");

  // --- An error twig (404) ---
  const notFound = await get("/this/path/does/not/exist");
  const nfNonce = cspNonce(notFound.headers["content-security-policy"] as string | undefined);
  assert("404 twig: status 404", notFound.status === 404, `status=${notFound.status}`);
  assert("404 twig: every inline <style>/<script> carries the header nonce",
    !!nfNonce && everyInlineTagCarries(notFound.body, nfNonce), `nonce=${nfNonce}`);
  assert("404 twig: emits NO inline style= attribute", !notFound.body.includes('style="'),
    "404 error page still emits a style= attribute");

  // --- The /__dev dashboard is CSP-clean (external assets only) ---
  const dev = await get("/__dev");
  const devNonce = cspNonce(dev.headers["content-security-policy"] as string | undefined);
  assert("/__dev: served (200)", dev.status === 200, `status=${dev.status}`);
  assert("/__dev: every inline <style>/<script> carries the header nonce (or none emitted)",
    !!devNonce && everyInlineTagCarries(dev.body, devNonce), `nonce=${devNonce}`);
  assert("/__dev: emits NO inline style= attribute", !dev.body.includes('style="'),
    "dev dashboard still emits a style= attribute");
} finally {
  server.close();
  delete process.env.TINA4_RATE_LIMIT;
  delete process.env.TINA4_DEBUG;
  delete process.env.TINA4_NO_BROWSER;
  delete process.env.TINA4_OVERRIDE_CLIENT;
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
