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

- `src/index.js` — Worker: Basic auth, UI, `/enqueue`, `/jobs`, queue and
  dead-letter consumers, the `Archiver` container class (the URL → document
  converter), and the `JobStore` DO (per-URL job status).
- `src/ui.js` — enqueue page + bookmarklet.
- `src/drive.js` — Google Drive upload.
- `container/server.mjs` — tiny HTTP server that shells out to percollate.
- `Dockerfile` — percollate + Chromium runtime.
- `scripts/get-refresh-token.mjs` — one-time Google OAuth helper.

## Setup

Prereqs: Node 18+, Docker (for building the container image locally), a
Cloudflare account on Workers Paid, a Google account whose Drive the Supernote
syncs, and [direnv](https://direnv.net). The repo ships an `.envrc` that loads a
local `.env` into your shell; without direnv, run `set -a && source .env && set +a`
before the setup scripts instead.

```sh
npm install
npx wrangler login
npx wrangler queues create read-later
npx wrangler queues create read-later-dlq   # dead-letter queue for exhausted retries
```

The job-status store is a Durable Object (`JOB_STORE`), so it needs no separate
create step: `wrangler deploy` provisions it.

Secrets live in one gitignored `.env` file that you build up over the steps below.
The same file serves three consumers: `.envrc` loads it for the setup scripts,
`wrangler dev` reads it for local runs, and `wrangler secret bulk .env` uploads it
to the deployed Worker. `BASIC_USER` is a plain var in `wrangler.toml`, so it stays
out of `.env`. direnv reloads `.env` automatically when it changes; run `direnv
reload` if a script reports a missing variable.

### 1. Google Drive access

1. Google Cloud console: create a project, enable the Drive API.
2. Create an OAuth client, type "Web application", redirect URI
   `http://localhost:8976/callback`.
3. Start `.env` with the client credentials, then trust it with direnv:
   ```
   GOOGLE_CLIENT_ID="..."
   GOOGLE_CLIENT_SECRET="..."
   ```
   ```sh
   direnv allow
   ```
4. Mint a refresh token (it reads the credentials from `.env`):
   ```sh
   npm run token
   ```
   Approve in the browser, then add the printed token to `.env`:
   ```
   GOOGLE_REFRESH_TOKEN="..."
   ```
5. Create the destination folder. The least-privilege `drive.file` scope only
   lets the app touch files/folders it creates itself, so the app must create the
   folder rather than you making it by hand (a hand-made folder is invisible to
   the app and uploads into it 404):
   ```sh
   npm run folder            # or: npm run folder -- "My Folder Name"
   ```
   Add the printed ID to `.env`:
   ```
   DRIVE_FOLDER_ID="..."
   ```
6. Move the new folder (created at My Drive root) into the location your device
   syncs, e.g. `Supernote/Document/`, using the Drive web UI. Moving it keeps the
   app's access, so uploads keep working. The Supernote then picks up new EPUBs on
   its next Drive sync.

Alternative (skip steps 5 and 6): to point at a folder you made by hand, re-run
the token step with the full-access scope,
`GOOGLE_SCOPE=https://www.googleapis.com/auth/drive npm run token`, then copy that
folder's ID from its Drive URL
`https://drive.google.com/drive/folders/<THIS_IS_THE_ID>` into `.env`. Simpler,
but grants the app your whole Drive instead of just its own files.

### 2. Secrets

Add the final value to `.env`, an ASCII-only Basic-auth password (the auth check
encodes it with `btoa`, which throws on non-Latin1 characters):

```
BASIC_PASS="..."
```

`.env` now holds all five secrets:

```
BASIC_PASS="..."
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
GOOGLE_REFRESH_TOKEN="..."
DRIVE_FOLDER_ID="..."
```

Upload them to the deployed Worker in one shot (or set them individually with
`npx wrangler secret put <NAME>`):

```sh
npx wrangler secret bulk .env
```

`wrangler dev` loads the same `.env` automatically for local runs. `BASIC_USER`
defaults to `read` in `wrangler.toml`.

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

## Feedback and reliability

- The page is a live dashboard: a form plus an auto-polling list of recent jobs
  (`/jobs`) showing each as working, done, skipped, or failed. Polling speeds up
  while a job is converting, slows when idle, and pauses when the tab is hidden.
- The bookmarklet opens that dashboard in a new tab and enqueues in the same
  click, so sends from any site get the same visual feedback. The enqueue rides
  its own authenticated fetch, so it succeeds even if the new tab has to re-auth.
- Job state lives in the `JobStore` Durable Object and self-expires after a week.
- Conversions that fail every retry land on `read-later-dlq` and are recorded as
  `failed` (with the URL) rather than being silently deleted, so you can re-send.

## Known limitations

- Paywalled or aggressively JS-gated sites may extract poorly; these are recorded
  as `dropped` (permanent) so the dashboard tells you rather than retrying forever.
- Opening the dashboard tab relies on the browser having cached your Basic-auth
  credentials for the Worker origin; if not, the new tab prompts once (the article
  is already queued regardless).
