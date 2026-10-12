/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * A form token rendered during a request is bound to that request's session.
 * Run with: npx tsx test/csrfFormTokenSessionBinding.test.ts
 *
 * The CSRF check compares a token's session_id with the session of the write
 * that carries it, but it can only do so when the token HAS a session_id. The
 * rendered token never had one: form_token() read a module-level id that no
 * dispatch path set, so a token rendered for one browser was accepted on a
 * write carrying any other browser's session cookie. These tests render the
 * token through the real TestClient pipeline, in one browser, and post it in
 * another.
 */
import { defaultRouter, get, post, getToken, startServer, TestClient, MiddlewareRunner, CsrfMiddleware, responseCache, clearCache } from "../packages/core/src/index.ts";
import type { Tina4Request, Tina4Response } from "../packages/core/src/index.ts";
import { Frond, setFormTokenSessionProvider } from "../packages/frond/src/engine.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { freePort } from "./freePort.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

console.log("=== CSRF form token session binding ===\n");

const tmpDir = mkdtempSync(join(tmpdir(), "tina4-csrf-binding-"));
const saved = {
  csrf: process.env.TINA4_CSRF, secret: process.env.TINA4_SECRET, path: process.env.TINA4_SESSION_PATH,
};
process.env.TINA4_CSRF = "true";
process.env.TINA4_SECRET = "test-csrf-secret-0123456789abcdef";
process.env.TINA4_SESSION_PATH = join(tmpDir, "sessions");

const render = () => new Frond().renderString("{{ form_token_value() }}").toString().trim();

function claims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
}

/** One cookie jar, sent with every request through the real dispatcher. */
class Browser {
  readonly cookies = new Map<string, string>();
  private readonly client = new TestClient();

  private headers(): Record<string, string> {
    if (this.cookies.size === 0) return {};
    return { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") };
  }

  private keep<T extends { getHeaderList(name: string): string[] }>(response: T): T {
    for (const value of response.getHeaderList("set-cookie")) {
      const [pair] = value.split(";", 1);
      const at = pair!.indexOf("=");
      this.cookies.set(pair!.slice(0, at), pair!.slice(at + 1));
    }
    return response;
  }

  async get(path: string) {
    return this.keep(await this.client.get(path, { headers: this.headers() }));
  }

  async post(path: string, token: string) {
    return this.keep(await this.client.post(path, { json: { formToken: token }, headers: this.headers() }));
  }

  async token(path = "/form"): Promise<string> {
    return (await this.get(path)).body.trim();
  }
}

async function main() {
  defaultRouter.clear();
  const savedMiddleware = MiddlewareRunner.getGlobal();
  MiddlewareRunner.reset();
  MiddlewareRunner.use(CsrfMiddleware);

  get("/login", async (req: Tina4Request, res: Tina4Response) => {
    (req as any).session.set("token", getToken({ user: "victim" }));
    return res.json({ logged_in: true });
  });
  get("/form", async (req: Tina4Request, res: Tina4Response) => {
    (req as any).session.set("seen", true);
    return res.html(render());
  });
  get("/fresh", async (_req: Tina4Request, res: Tina4Response) => res.html(render()));
  get("/cached", async (_req: Tina4Request, res: Tina4Response) => res.html(render()), [responseCache({ ttl: 60 })]);
  post("/save", async (_req: Tina4Request, res: Tina4Response) => res.json({ saved: true }));

  try {
    {
      const attacker = new Browser();
      const victim = new Browser();
      const stolen = await attacker.token();
      await victim.get("/login");
      await victim.token();
      const status = (await victim.post("/save", stolen)).status;
      assert("a token rendered for one session is refused on another", status === 403, `got ${status}`);
    }
    {
      const victim = new Browser();
      await victim.get("/login");
      const own = await victim.token();
      const status = (await victim.post("/save", own)).status;
      assert("a token passes on the session that rendered it", status === 200, `got ${status}`);
    }
    {
      // Nothing else stores the session on /fresh, so without a marker it would
      // send no cookie, and the visitor's own POST would arrive under a new id.
      const visitor = new Browser();
      const other = new Browser();
      const token = await visitor.token("/fresh");
      assert("rendering a bound token leaves a session cookie", visitor.cookies.size > 0);
      await visitor.get("/login");
      await other.get("/login");
      const own = (await visitor.post("/save", token)).status;
      const foreign = (await other.post("/save", token)).status;
      assert("a fresh page's token passes for its visitor", own === 200, `got ${own}`);
      assert("a fresh page's token is refused on another session", foreign === 403, `got ${foreign}`);
    }
    {
      // The session cookie is set after the response cache decides to store
      // the page, so a page whose token is bound to a NEW session must not be
      // stored: every later visitor would be served the first visitor's token.
      await clearCache();
      const first = new Browser();
      const second = new Browser();
      const firstToken = await first.token("/cached");
      const secondToken = await second.token("/cached");
      const statuses = [(await first.post("/save", firstToken)).status, (await second.post("/save", secondToken)).status];
      assert("a cached page does not replay one visitor's token to the next", !statuses.includes(403), `got ${statuses}`);
    }
    {
      await new Browser().get("/form");
      assert("a render outside a request is unbound", !("session_id" in claims(render())));
    }
    {
      // The live server registers the session source on its own path, apart
      // from the TestClient's: forget the TestClient's registration, then
      // drive a live server over a real socket.
      setFormTokenSessionProvider(() => "");
      const port = await freePort();
      const routesDir = join(tmpDir, "src", "routes");
      mkdirSync(routesDir, { recursive: true });
      const server = await startServer({ port, routesDir, modelsDir: join(tmpDir, "src", "models"),
        staticDir: join(tmpDir, "public") });
      try {
        const base = `http://127.0.0.1:${port}`;
        const jar = async (path: string, cookie = "") => {
          const res = await fetch(base + path, { headers: cookie ? { cookie } : {} });
          const set = res.headers.getSetCookie().map((c) => c.split(";", 1)[0]).join("; ");
          return { cookie: set || cookie, body: (await res.text()).trim() };
        };
        const stolen = (await jar("/form")).body;
        const victim = await jar("/login");
        const res = await fetch(base + "/save", { method: "POST",
          headers: { cookie: victim.cookie, "content-type": "application/json" },
          body: JSON.stringify({ formToken: stolen }) });
        assert("a live server refuses a token rendered for another session", res.status === 403, `got ${res.status}`);
      } finally {
        server.close();
      }
    }
  } finally {
    defaultRouter.clear();
    MiddlewareRunner.reset();
    for (const m of savedMiddleware) MiddlewareRunner.use(m);
    for (const [key, value] of [["TINA4_CSRF", saved.csrf], ["TINA4_SECRET", saved.secret], ["TINA4_SESSION_PATH", saved.path]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
