# read-later

One-click read-later for a Supernote device. Send a URL, get a clean EPUB in a
Google Drive folder that the Supernote syncs.

Flow: UI or bookmarklet → Cloudflare Worker (`/enqueue`) → Cloudflare Queue →
consumer calls a Cloudflare Container running **percollate**, which fetches the
page, runs Readability, embeds images, and builds the EPUB → Worker uploads it
to your `Supernote/Document/...` Drive folder.

## Why this design

- percollate is the whole extract-and-package pipeline off the shelf, so there
  is almost no custom conversion code to maintain.
- The container gives a real Node + Chromium environment (percollate needs it).
- The queue makes the UI return instantly and gives free retries on failure.

Trade-off: Cloudflare Containers require the **Workers Paid** plan ($5/mo plus
per-run container billing). This design is not free-tier eligible.

## Components

- `src/index.js` — Worker: Basic auth, UI, `/enqueue`, queue consumer, and the
  `Archiver` container class (the URL → document converter).
- `src/ui.js` — enqueue page + bookmarklet.
- `src/drive.js` — Google Drive upload.
- `container/server.mjs` — tiny HTTP server that shells out to percollate.
- `Dockerfile` — percollate + Chromium runtime.
- `scripts/get-refresh-token.mjs` — one-time Google OAuth helper.

## Setup

Prereqs: Node 18+, Docker (for building the container image locally), a
Cloudflare account on Workers Paid, a Google account whose Drive the Supernote
syncs.

```sh
npm install
npx wrangler login
npx wrangler queues create read-later
```

### 1. Google Drive access

1. Google Cloud console: create a project, enable the Drive API.
2. Create an OAuth client, type "Web application", redirect URI
   `http://localhost:8976/callback`. Note the client ID and secret.
3. Mint a refresh token:
   ```sh
   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy npm run token
   ```
   Open the printed URL, approve, copy the refresh token.
4. Destination folder ID: open `Supernote/Document/ReadLater` (create it if
   needed) in the Drive web UI and copy the ID from the URL
   `https://drive.google.com/drive/folders/<THIS_IS_THE_ID>`.

Scope note: the token script defaults to `drive.file` (least privilege). If
uploads fail with a 403/404 on the parent folder, re-run with
`GOOGLE_SCOPE=https://www.googleapis.com/auth/drive`.

### 2. Secrets

```sh
npx wrangler secret put BASIC_PASS
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put DRIVE_FOLDER_ID
```

`BASIC_USER` defaults to `read` in `wrangler.toml`. Use an ASCII-only
`BASIC_PASS`: the auth check encodes it with `btoa`, which throws on non-Latin1
characters.

### 3. Deploy

```sh
npm run deploy   # builds the Docker image, pushes it, deploys the Worker
```

Open `https://<your-worker>.workers.dev/`, log in with `read` / your
`BASIC_PASS`. Use the form or drag the bookmarklet to your bookmarks bar.

## iOS Share Sheet

Shortcut: Receive URLs → Get Contents of URL, POST, JSON body
`{ "url": <Shortcut Input> }`, header `Authorization: Basic <base64>` where the
base64 is `echo -n 'read:YOURPASS' | base64`.

## Verify on first deploy

Things I could not test without a live deploy; check these once:

- Container memory: Chromium is hungry. If percollate OOMs, raise
  `instance_type` in `wrangler.toml` (confirm valid names in current docs).
- `--no-sandbox`: required to run Chromium as root. If the `epub` subcommand
  rejects the flag on your percollate version, drop it and instead run the
  container as a non-root user in the Dockerfile.
- Watch logs with `npx wrangler tail` while sending a test URL.

## Known limitations

- Paywalled or aggressively JS-gated sites may extract poorly.
- Failed conversions are retried by the queue, then dropped after 3 tries.
