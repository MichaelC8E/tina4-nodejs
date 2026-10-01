# Task: Fix the loopBlockWatchdog readiness flake (CI ECONNREFUSED)

Outcome: test/loopBlockWatchdog.test.ts stops flaking on CI with
`TypeError: fetch failed / connect ECONNREFUSED 127.0.0.1:7842`.

## Root cause
- The harness treated a bare TCP `connect` success (`portAccepts`) as "ready".
- A plain connect can land on a listener that is about to vanish: the server
  takes over an occupied port via `killPort()`, so during the kill->rebind gap a
  connect succeeds against the dying occupant and the very next `fetch` refuses.
- Fixed ports 7841-7844 on a shared CI runner make an occupied port (a leaked
  listener from another step/run) likely, which is what arms the takeover.
- Python/PHP/Ruby have NO loop-block watchdog (Node single-event-loop concept),
  so there is no sibling test to port -- this is Node-only. serve-debug (ruby)
  already uses real-HTTP readiness (ShutdownProbe#wait_until_serving! +
  poll_status) and needed no change.

## Scope
- [x] Readiness is a COMPLETED HTTP GET (`serverAnswers` -> GET /fast == 200),
      never a bare TCP connect.
- [x] Test-body requests use `resilientGet` (retry a transient connection
      failure within a 3s bound) so a one-off refuse never fails an assertion.
- [x] Drop the now-unused `createConnection` import.

## Tests (real, no mocks -- a real spawned Tina4 server over real HTTP)
- [x] 5/5 pass, and 6/6 green under CPU load (`yes` x3) with TINA4_SECRET set
      (CI sets it; my shell lacked it, which surfaced the test's own missing-env
      boot path -- unrelated to the flake).
- [x] typecheck clean (tsc --noEmit).

## Bugs
- [x] CI ECONNREFUSED on /awaited after portAccepts said ready -- fixed by
      real-HTTP readiness + resilientGet.

## Commits
- (pending  test: real-HTTP readiness for loopBlockWatchdog, kill the ECONNREFUSED flake)

## Status: In Progress
