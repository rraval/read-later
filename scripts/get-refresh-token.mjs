#!/usr/bin/env node
// One-time helper to mint a Google OAuth refresh token for Drive uploads.
//
// Usage:
//   1. In Google Cloud console, enable the Drive API and create an OAuth client
//      of type "Web application" with redirect URI: http://localhost:8976/callback
//   2. Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (direnv loads them
//      into your shell), then run: npm run token
//   3. Approve in the browser, then add the printed refresh token to .env as
//      GOOGLE_REFRESH_TOKEN.
//
// Scope defaults to drive.file (least privilege: only files this app creates).
// If uploads later fail writing INTO the Supernote folder, re-run with
//   GOOGLE_SCOPE=https://www.googleapis.com/auth/drive npm run token
// and update GOOGLE_REFRESH_TOKEN in .env.

import http from "node:http";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SCOPE = process.env.GOOGLE_SCOPE || "https://www.googleapis.com/auth/drive.file";
const PORT = 8976;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (loaded by direnv).");
  process.exit(1);
}

// No CSRF `state` param: this is a one-shot flow against a localhost server the
// user starts themselves, so there's no cross-site request to protect against.
const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  const code = u.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("No code");
    return;
  }
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const data = await tokenRes.json();
  res.writeHead(200, { "content-type": "text/plain" });
  if (data.refresh_token) {
    res.end("Success. Refresh token printed in the terminal. You can close this tab.");
    console.log("\n=== Refresh token ===\n" + data.refresh_token + "\n");
    console.log('Add it to .env:\n  GOOGLE_REFRESH_TOKEN="' + data.refresh_token + '"\n');
    console.log("It uploads to the Worker later via `npx wrangler secret bulk .env`.\n");
  } else {
    res.end("No refresh_token returned. Revoke prior access and retry.\n" + JSON.stringify(data));
    console.error("No refresh_token in response:", data);
  }
  server.close();
});

server.listen(PORT, () => {
  console.log(`Open this URL to authorize (scope: ${SCOPE}):\n\n${authUrl}\n`);
});
