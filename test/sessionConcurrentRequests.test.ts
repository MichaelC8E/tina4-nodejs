/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * A request's save must not undo what another request did to the same session.
 *
 * Every request loads its session when it starts and saves it when it ends
 * (dispatchPipeline: a fresh Session, start() from the cookie, save() when the
 * response ends), and set()/delete()/clear() save straight away too. The save
 * used to write back the WHOLE snapshot loaded at the start, so a request that
 * was in flight across a logout put the logged-out session back the moment it
 * wrote anything: destroy(), clear() and regenerate() were all undone, and so
 * was a privilege change made with set(). A copied session cookie outlived the
 * logout that was meant to kill it.
 *
 * The save now writes only this request's own changes onto the record as it is
 * stored NOW, and never re-creates a record removed after this request loaded
 * it.
 *
 * Two Session objects over one directory stand in for two concurrent requests.
 * NO MOCKS: the real FileSessionHandler on a real temp dir, a real
 * RedisSessionHandler at a genuinely closed port for the unreachable store, and
 * every outcome read straight off disk, never through the session under test.
 *
 * Run with: npx tsx test/sessionConcurrentRequests.test.ts
 */
import net from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSessionHandler, RedisSessionHandler, Session } from "../packages/core/src/session.ts";

const TEST_PATH = mkdtempSync(join(tmpdir(), "tina4-session-concurrent-test-"));

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
  }
}

const same = (actual: unknown, expected: unknown): boolean =>
  JSON.stringify(actual) === JSON.stringify(expected);

/** What the server does at the start of a request: a fresh Session, started from the cookie. */
function request(sessionId?: string): Session {
  const session = new Session("file", { path: TEST_PATH });
  session.start(sessionId);
  return session;
}

function loggedIn(more: Record<string, unknown> = {}): string {
  const session = request();
  session.set("user", "alice");
  for (const [key, value] of Object.entries(more)) session.set(key, value);
  return session.getSessionId() as string;
}

/** On-disk path of a session, mirroring FileSessionHandler.filePath(). */
const sessionFile = (id: string): string =>
  join(TEST_PATH, `${createHash("sha256").update(id).digest("hex")}.json`);

/**
 * The record on disk for an id, without the _created/_accessed bookkeeping, or
 * null when there is none. Read from the file itself, not through Session.
 */
function stored(id: string): Record<string, unknown> | null {
  if (!existsSync(sessionFile(id))) return null;
  const record = { ...JSON.parse(readFileSync(sessionFile(id), "utf-8"))._data };
  delete record._created;
  delete record._accessed;
  return record;
}

/**
 * The absolute expiry deadline (unix seconds) the FileSessionHandler stored for
 * an id, read from the wrapper on disk — the field the handler stamps from
 * now + ttl on every write (0 means never-expires). Lets a test read the
 * deadline straight off disk, never through the session under test.
 */
const storedExpiry = (id: string): number =>
  JSON.parse(readFileSync(sessionFile(id), "utf-8"))._expires;

/** Remove every session record, so a check over all of them sees only its own. */
const freshStore = (): void => {
  for (const f of readdirSync(TEST_PATH)) rmSync(join(TEST_PATH, f), { force: true });
};

/** The user of every session record on disk, read from the files themselves. */
const usersStored = (): unknown[] =>
  readdirSync(TEST_PATH)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(TEST_PATH, f), "utf-8"))._data.user ?? null);

/** A port nothing is listening on, found by binding then releasing it. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

console.log("=== Session saves from concurrent requests ===\n");

// ── a request in flight does not undo a logout ───────────────────────

console.log("-- a request in flight does not undo a logout --");

{
  const sid = loggedIn();
  const slow = request(sid);
  request(sid).destroy();

  slow.set("cart", "one item");

  assert("destroy() stays destroyed after a slow request writes", stored(sid) === null);
  assert("the session ends for the slow request too, so no cookie goes out for it",
    slow.getSessionId() === null);
}

{
  const sid = loggedIn();
  const slow = request(sid);
  slow.get("user");
  request(sid).destroy();

  assert("a read-only slow request saves without error", slow.save() === true);
  assert("destroy() stays destroyed after a read-only slow request ends", stored(sid) === null);
}

{
  const sid = loggedIn();
  const slow = request(sid);
  request(sid).clear();

  slow.set("cart", "one item");

  assert("clear() stays cleared: the slow request does not write its old user back",
    same(stored(sid), { cart: "one item" }));
}

{
  const sid = loggedIn();
  const slow = request(sid);
  const newId = request(sid).regenerate();

  slow.set("cart", "one item");

  assert("the id regenerate() retired is not brought back", stored(sid) === null);
  assert("the new id keeps the session", same(stored(newId), { user: "alice" }));
}

{
  const sid = loggedIn();
  const slow = request(sid);
  request(sid).set("user", "nobody");

  slow.set("cart", "one item");

  assert("a downgrade made with set() stays down",
    same(stored(sid), { user: "nobody", cart: "one item" }));
}

{
  const sid = loggedIn();
  const slow = request(sid);
  request(sid).destroy();

  slow.set("cart", "one item");
  slow.set("more", "after");
  slow.save();

  assert("the session stays ended for the rest of the slow request", stored(sid) === null);
}

// ── a regenerate in flight does not carry an ended session ───────────
//
// The slow request calls regenerate() at its end (a privilege change, an SSO
// callback) after another request ended or changed the session. What it loaded
// must not reach the new id.

console.log("\n-- a regenerate in flight does not carry an ended session --");

{
  freshStore();
  const sid = loggedIn();
  const slow = request(sid);
  request(sid).destroy();

  assert("regenerate() mints no id for a session another request destroyed", slow.regenerate() === null);
  assert("so no cookie goes out for it", slow.getSessionId() === null);
  assert("the logged-out session is not carried to a new id", !usersStored().includes("alice"));
}

{
  freshStore();
  const sid = loggedIn();
  const slow = request(sid);
  request(sid).clear();

  slow.regenerate();

  assert("a cleared session is not carried to a new id", !usersStored().includes("alice"));
}

{
  freshStore();
  const sid = loggedIn();
  const slow = request(sid);
  slow.set("cart", "one item");
  request(sid).set("user", "nobody");

  const newId = slow.regenerate() as string;

  assert("regenerate() carries a downgrade along with the slow request's own change",
    same(stored(newId), { user: "nobody", cart: "one item" }));
  assert("and removes the old id", stored(sid) === null);
}

{
  freshStore();
  // Both requests carry the same pre-login cookie. The first to finish rotates
  // the id; the other must not mint a second, empty session whose cookie would
  // replace it.
  const anon = request();
  anon.set("pending", "state");
  const first = request(anon.getSessionId() as string);
  const second = request(anon.getSessionId() as string);

  second.set("user", "alice");
  const winner = second.regenerate() as string;
  first.set("user", "alice");
  first.save();

  assert("a double-submitted login: the loser's regenerate() mints nothing", first.regenerate() === null);
  assert("so no cookie goes out to replace the winning login", first.getSessionId() === null);
  assert("the winning login is stored", same(stored(winner), { pending: "state", user: "alice" }));
  assert("and it is the only session stored", same(usersStored(), ["alice"]));
}

{
  // docs/nodejs/09-sessions-cookies.md: regenerate(), then set the user.
  freshStore();
  const anon = request();
  anon.set("pending", "state");
  const first = request(anon.getSessionId() as string);
  const second = request(anon.getSessionId() as string);

  const winner = second.regenerate() as string;
  second.set("user", "alice");

  assert("a double-submitted login in the documented order: the loser mints nothing",
    first.regenerate() === null);
  first.set("user", "alice");
  first.save();

  assert("and sends no cookie", first.getSessionId() === null);
  assert("the winner is stored", same(stored(winner), { pending: "state", user: "alice" }));
  assert("and is the only session stored", same(usersStored(), ["alice"]));
}

{
  // docs/nodejs/09-sessions-cookies.md: regenerate(), then set the user.
  const anon = request();
  anon.set("csrf", "token");
  const session = request(anon.getSessionId() as string);

  const newId = session.regenerate() as string;
  session.set("user_id", 42);
  session.save();

  assert("the documented login stores the user under the new id",
    same(stored(newId), { csrf: "token", user_id: 42 }));
  assert("and removes the pre-login id", stored(anon.getSessionId() as string) === null);
}

{
  freshStore();
  const sid = loggedIn();
  const session = request(sid);
  session.destroy();

  const newId = session.regenerate();

  assert("regenerate() after this request's own destroy() still starts afresh",
    typeof newId === "string" && newId.length > 0 && newId !== sid);
  assert("and the destroyed id stays gone", stored(sid) === null);
}

// ── concurrent requests keep each other's changes ────────────────────

console.log("\n-- concurrent requests keep each other's changes --");

{
  const sid = loggedIn();
  const first = request(sid);
  const second = request(sid);

  first.set("theme", "dark");
  second.set("cart", "one item");

  assert("two requests setting different keys both persist",
    same(stored(sid), { user: "alice", theme: "dark", cart: "one item" }));
}

{
  const sid = loggedIn({ mfa: "verified" });
  const slow = request(sid);
  request(sid).delete("mfa");

  slow.set("cart", "one item");

  assert("a key another request deleted stays deleted",
    same(stored(sid), { user: "alice", cart: "one item" }));
}

{
  const sid = loggedIn();
  const logout = request(sid);
  request(sid).set("mfa", "verified");

  logout.clear();

  assert("clear() also removes keys another request added", same(stored(sid), {}));
}

{
  const sid = loggedIn();
  const first = request(sid);
  const second = request(sid);

  first.set("user", "bob");
  second.set("user", "carol");

  assert("the last save wins when both change one key", stored(sid)?.user === "carol");
}

// ── a save still writes what the request changed ─────────────────────

console.log("\n-- a save still writes what the request changed --");

{
  // ADR-0087: a session's expiry slides on activity. A read-only request
  // re-writes the stored record even though it changed nothing, so the backend
  // deadline moves forward — the session expires after TINA4_SESSION_TTL of
  // INACTIVITY, not that long after its last change. Mirrors tina4-php's
  // testAnUnchangedSessionIsStillWrittenSoExpiryCountsFromTheLastRequest.
  const sid = loggedIn();
  const session = new Session("file", { path: TEST_PATH, ttl: 3600 });
  session.start(sid);
  session.get("user");   // a request that touched nothing

  // Put the stored deadline about to expire, the way the php test does, then
  // let the read-only save re-stamp it to now + ttl.
  const file = sessionFile(sid);
  const wrapper = JSON.parse(readFileSync(file, "utf-8"));
  const aboutToExpire = Math.floor(Date.now() / 1000) + 5;
  wrapper._expires = aboutToExpire;
  writeFileSync(file, JSON.stringify(wrapper));

  assert("a read-only request saves without error", session.save() === true);
  assert("a read-only request moves the expiry forward",
    storedExpiry(sid) > Math.floor(Date.now() / 1000) + 3000);
  assert("a read-only save leaves the stored data unchanged", same(stored(sid), { user: "alice" }));
}

{
  const sid = loggedIn({ cart: ["one item"] });
  const session = request(sid);
  (session.get("cart") as string[]).push("two items");
  session.set("seen", true);

  assert("a value changed in place is saved with the next set()",
    same(stored(sid)?.cart, ["one item", "two items"]));
}

{
  const session = request();
  session.set("user", "alice");
  session.set("theme", "dark");

  assert("a new session is written whole",
    same(stored(session.getSessionId() as string), { user: "alice", theme: "dark" }));
}

{
  const sid = loggedIn();
  const session = request(sid);
  session.set("theme", "dark");
  const other = request(sid);
  other.set("user", "nobody");
  other.set("theme", "light");

  session.set("cart", "one item");

  assert("a second save writes only what changed since the first",
    same(stored(sid), { user: "nobody", theme: "light", cart: "one item" }));
}

{
  const session = request();
  session.set("user", "alice");
  const sid = session.getSessionId() as string;
  request(sid).destroy();

  session.set("cart", "one item");
  session.save();

  assert("a new session's later save does not bring it back once destroyed", stored(sid) === null);
}

{
  const sid = loggedIn();
  const session = request(sid);
  session.clear();
  session.set("theme", "dark");
  request(sid).set("mfa", "verified");

  session.set("cart", "one item");

  assert("a save after clear() and a save merges again",
    same(stored(sid), { theme: "dark", mfa: "verified", cart: "one item" }));
}

{
  const sid = loggedIn();
  const session = request(sid);
  session.clear();
  session.save();

  session.set("cart", "one item");
  session.save();

  assert("a set() after clear() and a save is still stored", same(stored(sid), { cart: "one item" }));
}

{
  // The SSO callback: consume the pending state, regenerate, store the identity.
  const anon = request();
  anon.set("pending", "state");
  const session = request(anon.getSessionId() as string);
  session.delete("pending");
  const newId = session.regenerate() as string;

  session.set("user", "alice");
  session.save();

  assert("a set() after regenerating an emptied session is still stored",
    same(stored(newId), { user: "alice" }));
  assert("and the session stays on the new id", session.getSessionId() === newId);
}

{
  const sid = loggedIn({ theme: "dark" });
  const session = request(sid);
  session.clear();
  session.set("user", "bob");

  assert("clear() then set() in one request writes only the new data",
    same(stored(sid), { user: "bob" }));
}

{
  const sid = loggedIn({ theme: "dark" });
  const newId = request(sid).regenerate();

  assert("regenerate() carries everything to the new id",
    same(stored(newId), { user: "alice", theme: "dark" }));
  assert("regenerate() removes the old id", stored(sid) === null);
}

// ── a store that cannot be read at save time ─────────────────────────

console.log("\n-- a store that cannot be read at save time --");

{
  const sid = loggedIn();
  const session = request(sid);

  // The store becomes unreachable between start() and save(): the REAL redis
  // handler, pointed at a port the kernel really refuses.
  const deadPort = await closedPort();
  session.setHandler(new RedisSessionHandler({ redisHost: "127.0.0.1", redisPort: deadPort }));
  session.set("cart", "one item");
  assert("a save that could not read the store reports failure", session.save() === false);
  assert("nothing is written while the store cannot be read", same(stored(sid), { user: "alice" }));

  session.setHandler(new FileSessionHandler(TEST_PATH));
  assert("the retained change is written once the store answers again", session.save() === true);
  assert("and it lands on the stored record",
    same(stored(sid), { user: "alice", cart: "one item" }));
}

// ── Cleanup ──────────────────────────────────────────────────────────

try { rmSync(TEST_PATH, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
