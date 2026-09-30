/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Parity guard for tina4stack/tina4-php#253.
 *
 * The upstream bug was PHP-only: under `tina4 serve` (the raw-socket server),
 * PHP's native $_SESSION bridge re-emitted the session cookie only when the
 * session was NEW at the start of the request. A mid-request
 * session_regenerate_id() -- the standard session-fixation defence on login --
 * rotated the id AFTER that check, so no Set-Cookie went out and the session
 * was lost on the very next request.
 *
 * Node was never affected: dispatchPipeline.ts re-emits the cookie whenever
 * `newSid !== existingSid` (the id the client sent), covering a brand-new
 * session AND a mid-request regenerate. A bug reported against one framework
 * almost always exists in the others, so it earns a permanent regression test
 * here too -- if the serve path ever stopped propagating a rotated id, this
 * goes red.
 *
 * Proven over a REAL startServer() (no mocks), the exact server `tina4 serve`
 * boots. Mirrors test/sessionBuiltinServerCookie.test.ts.
 *
 * Run with: npx tsx test/sessionRegenerateCookie.test.ts
 */
import { startServer } from "../packages/core/src/index.ts";
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort } from "./freePort.ts";

const TEST_DIR = mkdtempSync(join(tmpdir(), "tina4-session-regenerate-cookie-test-"));
const PORT = await freePort();
let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function get(path: string, cookie?: string): Promise<{ setCookies: string[]; status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (cookie) headers["Cookie"] = cookie;
    const req = http.request(
      { hostname: "127.0.0.1", port: PORT, path, method: "GET", headers },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          const raw = res.headers["set-cookie"];
          const setCookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
          let body: any = null;
          try { body = JSON.parse(data); } catch { /* leave null */ }
          resolve({ setCookies, status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// GET /regen writes the session and rotates its id; GET /whoami reads it back.
try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(join(TEST_DIR, "src/routes/regen"), { recursive: true });
mkdirSync(join(TEST_DIR, "src/routes/whoami"), { recursive: true });
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');
writeFileSync(join(TEST_DIR, "src/routes/regen/get.ts"), `
export const noAuth = true;
export default async function (req: any, res: any) {
  req.session.set("hit", ((req.session.get("hit") as number) ?? 0) + 1);
  const id = req.session.regenerate();
  return res.json({ id, hit: req.session.get("hit") });
}
`);
writeFileSync(join(TEST_DIR, "src/routes/whoami/get.ts"), `
export const noAuth = true;
export default async function (req: any, res: any) {
  return res.json({ id: req.session.getSessionId(), hit: req.session.get("hit") ?? null });
}
`);

const sessDir = mkdtempSync(join(tmpdir(), "tina4-session-regenerate-cookie-"));
process.env.TINA4_SESSION_PATH = sessDir;
process.env.TINA4_RATE_LIMIT = "100000";
process.env.TINA4_SECRET = process.env.TINA4_SECRET ?? "test-secret-session-regenerate-0123456789abcd";

console.log("=== Session contract - regenerate mid-request re-emits the cookie (parity guard, tina4-php#253) ===\n");

const server = await startServer({
  port: PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  staticDir: join(TEST_DIR, "public"),
});

// Request 1: write + rotate the id in one request.
const regen = await get("/regen");
assert("regen succeeds", regen.status === 200, `got status=${regen.status} body=${JSON.stringify(regen.body)}`);
assert("regen wrote hit=1", regen.body?.hit === 1, `got ${JSON.stringify(regen.body)}`);
const rotatedId: string | undefined = regen.body?.id;
assert("regen returned a new id", typeof rotatedId === "string" && rotatedId.length > 0, `got ${JSON.stringify(regen.body)}`);

const emitted = regen.setCookies.find((c) => c.startsWith("tina4_session="));
assert("a request that rotated the id emits a Set-Cookie",
  !!emitted, `got: ${JSON.stringify(regen.setCookies)}`);
assert("the emitted cookie carries the rotated id",
  !!emitted && !!rotatedId && emitted.split(";")[0].split("=")[1] === rotatedId,
  `emitted=${emitted} rotatedId=${rotatedId}`);

// Request 2: replay the rotated cookie -- the session must resume under the new id.
if (emitted) {
  const cookiePair = emitted.split(";")[0];
  const whoami = await get("/whoami", cookiePair);
  assert("the rotated session survives to the next request (hit=1)",
    whoami.body?.hit === 1, `got ${JSON.stringify(whoami.body)}`);
  assert("the next request runs under the rotated id",
    whoami.body?.id === rotatedId, `got ${JSON.stringify(whoami.body)} rotatedId=${rotatedId}`);
}

server.close();

delete process.env.TINA4_SESSION_PATH;
delete process.env.TINA4_RATE_LIMIT;
try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
try { rmSync(sessDir, { recursive: true }); } catch { /* ignore */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
