/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * FRAGMENTED MESSAGES (RFC 6455 section 5.4) are delivered whole, on both server paths.
 * Run with: npx tsx test/websocketFragments.test.ts
 *
 * A browser sends a large message (a pasted image in a chat, base64 in JSON) as a TEXT frame with FIN clear, then
 * CONTINUATION frames. The server delivered the first piece as the whole message and dropped the rest, so the app's
 * JSON.parse failed ("invalid json" in tina4-simple-agent, 2026-09-30). The Python master assembles fragments
 * (tina4_python/websocket _handle_frame); this is the same design. Real sockets, real frames - no doubles.
 */
import net from "node:net";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer, Router, defaultRouter, serveWebSocketRoute } from "../packages/core/src/index.ts";
import type { WebSocketConnection, WebSocketRouteHandler } from "../packages/core/src/index.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

/** A client frame: always masked, as RFC 6455 requires of a client. */
function clientFrame(fin: boolean, opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len])
    : len < 65536 ? Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126]), Buffer.from([len >> 8, len & 255])])
    : (() => { const b = Buffer.alloc(10); b[0] = (fin ? 0x80 : 0) | opcode; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
  const body = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
  return Buffer.concat([head, mask, body]);
}

async function rawClient(port: number, path: string): Promise<net.Socket> {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise<void>((r) => socket.once("connect", () => r()));
  socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await new Promise<void>((r) => { let h = ""; const on = (c: Buffer) => { h += c.toString("latin1"); if (h.includes("\r\n\r\n")) { socket.off("data", on); r(); } }; socket.on("data", on); });
  return socket;
}

const settle = () => new Promise((r) => setTimeout(r, 300));
const IMAGE = JSON.stringify({ type: "user", content: "see this", image: "data:image/png;base64," + randomBytes(90_000).toString("base64") });

/** Send `text` as a TEXT frame plus continuations, with a PING between two pieces (control frames may interleave). */
function sendFragmented(socket: net.Socket, text: string, pieces = 3): void {
  const buf = Buffer.from(text, "utf-8");
  const size = Math.ceil(buf.length / pieces);
  for (let i = 0; i < pieces; i++) {
    const part = buf.subarray(i * size, Math.min(buf.length, (i + 1) * size));
    socket.write(clientFrame(i === pieces - 1, i === 0 ? 0x1 : 0x0, part));
    if (i === 0) socket.write(clientFrame(true, 0x9, Buffer.from("ping")));
  }
}

console.log("=== WebSocket fragmented messages ===\n");

// --- 1. WebSocketServer (processBuffer) ---
console.log("--- WebSocketServer ---");
{
  const server = new WebSocketServer({ port: 0 });
  const got: Array<string | Buffer> = [];
  server.on("message", (_client: unknown, message: string | Buffer) => { got.push(message); });
  await server.start();
  const port = ((server as unknown as { server: net.Server }).server.address() as net.AddressInfo).port;

  const a = await rawClient(port, "/");
  sendFragmented(a, IMAGE);
  await settle();
  assert("a fragmented TEXT message arrives once, whole", got.length === 1 && got[0] === IMAGE, `got ${got.length} message(s), first ${String(got[0]).length} chars of ${IMAGE.length}`);
  assert("the whole message parses as JSON", (() => { try { return JSON.parse(String(got[0])).type === "user"; } catch { return false; } })());

  got.length = 0;
  const bin = randomBytes(5000);
  a.write(clientFrame(false, 0x2, bin.subarray(0, 2000)));
  a.write(clientFrame(true, 0x0, bin.subarray(2000)));
  await settle();
  assert("a fragmented BINARY message arrives whole", got.length === 1 && Buffer.isBuffer(got[0]) && (got[0] as Buffer).equals(bin));

  got.length = 0;
  a.write(clientFrame(true, 0x0, Buffer.from("stray")));
  a.write(clientFrame(true, 0x1, Buffer.from("after")));
  await settle();
  assert("NEGATIVE: a continuation with no start is dropped; the next message is unaffected", got.length === 1 && got[0] === "after", JSON.stringify(got.map(String)));

  a.destroy();
  server.stop();
}

// --- 2. Router.websocket routes (serveWebSocketRoute), the path an app's websocket() uses ---
console.log("\n--- Router.websocket route ---");
{
  defaultRouter.clear();
  const got: string[] = [];
  const handler: WebSocketRouteHandler = async (conn: WebSocketConnection, event, data) => {
    if (event === "message") got.push(String(data));
    void conn;
  };
  Router.websocket("/ws/fragments", handler);
  const srv = createServer((_req, res) => { res.writeHead(426); res.end(); });
  srv.on("upgrade", (req, socket, head) => { if (!serveWebSocketRoute(req, socket, head)) socket.destroy(); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;

  const b = await rawClient(port, "/ws/fragments");
  sendFragmented(b, IMAGE, 4);
  await settle();
  assert("a fragmented TEXT message reaches the route once, whole", got.length === 1 && got[0] === IMAGE, `got ${got.length} message(s), first ${String(got[0] ?? "").length} chars of ${IMAGE.length}`);

  got.length = 0;
  b.write(clientFrame(true, 0x1, Buffer.from("small")));
  await settle();
  assert("an unfragmented message still arrives as before", got.length === 1 && got[0] === "small");

  b.destroy();
  srv.close(); // an upgraded socket is not an HTTP connection - the process exits below
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);
