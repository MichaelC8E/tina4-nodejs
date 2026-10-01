# Task: CSP nonce for framework inline content (fix unstyled fresh-init render)

Outcome: a fresh `tina4 init nodejs` project renders STYLED under the strict default CSP. Keep
`default-src 'self'`; make the framework's own inline `<style>`/`<script>` CSP-clean via a
per-response nonce, and de-inline every `style="..."` / `on*=` the framework emits. No 'unsafe-inline'.
Mirrors tina4-python #190 (ADR-0088) idiomatically in TypeScript.

## Scope
- [x] Per-response nonce module (`packages/core/src/csp.ts`): AsyncLocalStorage + generate + Frond global `cspNonce`
- [x] `response.cspNonce` field (types.ts + response.ts)
- [x] Wire nonce per request in `server.ts` runDispatch (runWithCspNonce, mirror runWithRequestId)
- [x] Frond global `csp_nonce()` registered in engine `_globals`
- [x] CSP header: inject `'nonce-X'` into style-src AND script-src (default + user TINA4_CSP) in SecurityHeadersMiddleware
- [x] Update TINA4_CSP one-time warning text (inline now works via nonce)
- [x] Nonce every framework inline `<style>`/`<script>`: landing page, swagger, errorOverlay, error twigs, gallery
- [x] De-inline every `style="..."` the framework emits (classes in the page's nonce'd <style>)
- [x] De-inline landing-page + gallery inline `onclick=` to addEventListener
- [x] Scaffold auth forms (login/register) de-inlined + nonce'd `<style>` demonstrating csp_nonce() (init.ts)
- [x] Document csp_nonce() for app developers (CLAUDE.md)
- [ ] FOLLOW-UP (flagged, out of this scope): crud/autoCrud row-level onclick handlers if any (dynamic JSON payloads)

## Parity
| Feature | Python | PHP | Ruby | Node |
|---------|--------|-----|------|------|
| csp-nonce | ✅ (ref #190) | ❌ (mirror) | ❌ (mirror) | ✅ THIS |

## Tests (real, no mocks, positive + negative)
- [x] CSP header on `/` carries 'nonce-' in style-src AND script-src (real boot) — cspNonceInline.test.ts
- [x] landing page inline <style>/<script> carry that exact nonce — real server
- [x] no style= / onclick= emitted by framework welcome page, error page, /__dev
- [x] negative: two requests get DIFFERENT nonces (per-response)
- [x] updated contract mirrors: securityHeadersContract, httpHardeningContract, cspDefaultWarning, staticSecurityHeaders, securityHeadersEveryResponseContract, entryPointSecurityParity

## Bugs
- [x] fresh-init `/` welcome page rendered unstyled under default CSP — fixed via per-response nonce

## Commits
- (on branch fix/csp-nonce-inline — see PR)

## Status: Complete (Node mirror of python #190). Deterministic single-response verify green,
full CSP/security/frond/swagger/devAdmin/gallery neighbourhood green, typecheck exit 0,
metrics gate green + re-baselined (3.8.95). PHP/Ruby still to mirror.
