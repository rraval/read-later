#!/usr/bin/env node
// One-time helper to create the destination Drive folder under the least-privilege
// `drive.file` scope, and print its ID for DRIVE_FOLDER_ID.
//
// Why this exists: `drive.file` only grants access to files/folders THIS app
// creates (or that the user hands it via the Picker). A folder you make by hand in
// the Drive web UI is invisible to the app, so uploading into it returns 404. By
// having the app create the folder, the app keeps `drive.file` access to it — and
// to everything it later uploads inside — so no broad `drive` scope is needed.
//
// Usage: needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN
// in .env (direnv loads them into your shell), then:
//   npm run folder                    # creates a folder named "ReadLater"
//   npm run folder -- "My Folder Name"  # custom name
//
// The folder is created at My Drive root (the app can't set a hand-made folder as
// its parent — same 404 reason). Move it into your e-reader's synced location in
// the Drive UI afterwards; moving it does not revoke the app's access.

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const NAME = process.argv[2] || process.env.FOLDER_NAME || "ReadLater";

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error(
    "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in .env (loaded by direnv)."
  );
  process.exit(1);
}

async function accessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

const token = await accessToken();
const res = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,name", {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ name: NAME, mimeType: "application/vnd.google-apps.folder" }),
});
if (!res.ok) throw new Error(`folder create failed: ${res.status} ${await res.text()}`);

const folder = await res.json();
console.log(`\n=== Created folder "${folder.name}" ===\n${folder.id}\n`);
console.log("Next:");
console.log("  1. In the Drive web UI, move this folder into the location your");
console.log("     e-reader syncs (moving it keeps the app's access).");
console.log('  2. Add its ID to .env:');
console.log(`       DRIVE_FOLDER_ID="${folder.id}"`);
console.log("     It uploads to the Worker later via `npx wrangler secret bulk .env`.\n");
