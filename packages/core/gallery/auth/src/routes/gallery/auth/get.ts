/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/** Gallery: Auth — JWT login with a visual demo page. */
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export default async function (_req: Tina4Request, res: Tina4Response) {
  // CSP-clean under the strict default policy (ADR-0088): one nonce'd <style>
  // holds the rules, no style= attributes, and the buttons bind via
  // addEventListener instead of inline onclick= (a nonce covers an element,
  // never an attribute). res.cspNonce matches the Content-Security-Policy header.
  const nonce = res.cspNonce;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Auth Demo</title><link rel="stylesheet" href="/css/tina4.min.css">
<style nonce="${nonce}">
.auth-container { max-width: 600px; }
.auth-hidden { display: none; }
.token-box { word-break: break-all; white-space: pre-wrap; color: #4ade80; background: #1e293b; padding: 1rem; border-radius: 0.5rem; }
.payload-box { color: #38bdf8; background: #1e293b; padding: 1rem; border-radius: 0.5rem; }
.auth-info-card { border: 1px solid #334155; }
.auth-info-title { color: #e2e8f0; }
.auth-howto { background: #0f172a; color: #4ade80; padding: 1rem; border-radius: 0.5rem; font-size: 0.8rem; }
</style>
</head>
<body class="bg-dark text-light">
<div class="container mt-5 auth-container">
    <h2 class="mb-4">JWT Authentication Demo</h2>
    <div class="card mb-4">
        <div class="card-header bg-primary text-white">Login</div>
        <div class="card-body">
            <div class="form-group mb-3">
                <label class="form-label">Username</label>
                <input type="text" id="username" class="form-control" placeholder="admin" value="admin">
            </div>
            <div class="form-group mb-3">
                <label class="form-label">Password</label>
                <input type="password" id="password" class="form-control" placeholder="secret" value="secret">
            </div>
            <button class="btn btn-primary" data-action="login">Login</button>
        </div>
    </div>
    <div id="result" class="auth-hidden">
        <div class="card mb-3">
            <div class="card-header bg-success text-white">Token Received</div>
            <div class="card-body">
                <pre id="token" class="token-box"></pre>
            </div>
        </div>
        <div class="card mb-3">
            <div class="card-header">Token Payload (decoded)</div>
            <div class="card-body">
                <pre id="payload" class="payload-box"></pre>
            </div>
        </div>
        <button class="btn btn-outline-info" data-action="verify">Verify Token</button>
        <span id="verify-result" class="ms-2"></span>
    </div>
    <div class="card bg-dark mt-4 auth-info-card">
        <div class="card-body">
            <h6 class="auth-info-title">How it works</h6>
            <pre class="auth-howto"><code>import { Auth } from "tina4-nodejs";
const auth = new Auth();
const token = auth.createToken({ username: "admin" });
const payload = auth.getPayload(token);
const isValid = auth.validateToken(token);</code></pre>
        </div>
    </div>
</div>
<script nonce="${nonce}">
var currentToken = '';
function doLogin() {
    fetch('/api/gallery/auth/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value
        })
    }).then(r => r.json()).then(d => {
        if (d.token) {
            currentToken = d.token;
            document.getElementById('token').textContent = d.token;
            try {
                var parts = d.token.split('.');
                var payload = JSON.parse(atob(parts[1]));
                document.getElementById('payload').textContent = JSON.stringify(payload, null, 2);
            } catch(e) {
                document.getElementById('payload').textContent = 'Could not decode';
            }
            document.getElementById('result').classList.remove('auth-hidden');
            document.getElementById('verify-result').textContent = '';
        } else {
            alert(d.error || 'Login failed');
        }
    });
}
function verifyToken() {
    fetch('/api/gallery/auth/verify?token=' + encodeURIComponent(currentToken))
    .then(r => r.json()).then(d => {
        var el = document.getElementById('verify-result');
        if (d.valid) {
            el.innerHTML = '<span class="badge bg-success">Valid</span>';
        } else {
            el.innerHTML = '<span class="badge bg-danger">Invalid</span>';
        }
    });
}
document.querySelectorAll('[data-action="login"]').forEach(function(b){ b.addEventListener('click', doLogin); });
document.querySelectorAll('[data-action="verify"]').forEach(function(b){ b.addEventListener('click', verifyToken); });
</script>
</body></html>`;
  return res.html(html);
}
