# read-later

One-click read-later. Send a URL, get a clean EPUB in a Google Drive folder that
an e-reader (e.g. a Supernote) syncs. Multi-user: each person signs in with
Google and picks their own destination folder.

Flow: UI or bookmarklet → Cloudflare Worker (`/enqueue`) → Cloudflare Queue →
consumer calls a Cloudflare Container running **percollate**, which fetches the
page, runs Readability, embeds images, and builds the EPUB → Worker uploads it to
the signed-in user's chosen Drive folder using their own credentials.

## Why this design

- percollate is the whole extract-and-package pipeline off the shelf, so there
  is almost no custom conversion code to maintain.
- The container gives a real Node + Chromium environment (percollate needs it).
- The queue makes the UI return instantly and gives free retries on failure.

Trade-off: Cloudflare Containers require the **Workers Paid** plan ($5/mo plus
per-run container billing). This design is not free-tier eligible.

## Components

- `src/index.js` — Worker: Google OAuth login (`/auth/login`, `/auth/callback`,
  `/logout`) + signed-cookie sessions, UI, `/folder`, `/enqueue`, `/jobs`, the
  queue consumer, the `Archiver` container class (the URL → document
  converter), and the `Store` DO (users + per-user job status).
- `src/ui.js` — sign-in page, dashboard, Drive folder Picker, bookmarklet.
- `src/drive.js` — Google Drive upload + folder lookup (per-user credentials).
- `container/server.mjs` — tiny HTTP server that shells out to percollate.
- `Dockerfile` — percollate + Chromium runtime.

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
```

The app-state store is a Durable Object (`STORE`), so it needs no separate create
step: `wrangler deploy` provisions it.

Secrets live in one gitignored `.env` file that you build up over the steps below.
The same file serves three consumers: `.envrc` loads it for the setup scripts,
`wrangler dev` reads it for local runs, and `wrangler secret bulk .env` uploads it
to the deployed Worker. direnv reloads `.env` automatically when it changes; run
`direnv reload` if a script reports a missing variable.

### 1. Google Cloud project

Users sign in with Google; the app stores each user's Drive `drive.file` refresh
token (encrypted) and the folder they pick via the Google Picker. Access is
gated by an email allowlist.

1. Google Cloud console: create a project, and enable both the **Google Drive
   API** and the **Google Picker API** (two separate toggles).
2. OAuth consent screen: set the user type to External and add your app's brand
   details. Add the scopes `openid`, `email`, `profile`, and
   `.../auth/drive.file`. These are non-sensitive, so this needs only basic
   OAuth App Verification, not the restricted-scope CASA security assessment.
3. Publish the consent screen to **Production** (do not leave it in Testing). In
   Testing, Google expires each user's refresh token 7 days after consent, which
   would break background uploads. Production has no such expiry. Access is
   controlled by `ALLOWED_EMAILS` (below), not by the publishing status.
4. Create an OAuth client, type "Web application":
   - Authorized JavaScript origins: `http://localhost:8787` (wrangler dev) and
     `https://<your-worker>.workers.dev`.
   - Authorized redirect URIs: `http://localhost:8787/auth/callback` and
     `https://<your-worker>.workers.dev/auth/callback`.
   Put the credentials in `.env`:
   ```
   GOOGLE_CLIENT_ID="..."
   GOOGLE_CLIENT_SECRET="..."
   ```
5. Create an API key (Credentials → Create → API key). Restrict it to the Google
   Picker API and, under Application restrictions, to your Worker's HTTP
   referrers. This is the Picker developer key.
6. Note the project number (Cloud console dashboard, or the numeric prefix of the
   client id). It is the Picker `appId`.

### 2. Secrets and vars

Everything the Worker needs lives in one gitignored `.env`. `SESSION_SECRET`
signs the session cookie and derives the key that encrypts stored refresh
tokens; generate it with `openssl rand -hex 32`. `ALLOWED_EMAILS` is a
comma-separated list of the Google accounts allowed to sign in.

```
SESSION_SECRET="..."           # openssl rand -hex 32
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
ALLOWED_EMAILS="alice@gmail.com,bob@gmail.com"
GOOGLE_API_KEY="..."           # Picker developer key from step 5
GOOGLE_PROJECT_NUMBER="..."    # Picker appId from step 6
```

Upload them to the deployed Worker in one shot (or set them individually with
`npx wrangler secret put <NAME>`):

```sh
npx wrangler secret bulk .env
```

`wrangler dev` loads the same `.env` automatically for local runs.

### 3. Deploy

```sh
npm run deploy   # builds the Docker image, pushes it, deploys the Worker
```

Open `https://<your-worker>.workers.dev/`, sign in with Google (an allowlisted
account), click "Choose folder…" to pick your Drive destination, then use the
form or drag the bookmarklet to your bookmarks bar. Each user picks their own
folder and their EPUBs upload there.

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
- The bookmarklet opens that dashboard in a new tab with the URL pre-filled into
  the form; you click Send to enqueue (a same-origin POST), and the list refreshes
  in place, so the job is visible with no manual refresh. Requiring the explicit
  click keeps the enqueue CSRF-safe (there is no side-effecting GET).
- Job state lives in the `Store` Durable Object (scoped per user) and self-expires
  after a week.
- Conversions that fail every retry are recorded as `failed` (with the URL and
  the error) rather than being silently deleted, and each failed or skipped job
  gets a Retry button that re-enqueues the URL.

## Known limitations

- Paywalled or aggressively JS-gated sites may extract poorly; these are recorded
  as `dropped` (permanent) so the dashboard tells you rather than retrying forever.
- A logged-out bookmarklet click routes through `/login` first; the URL is
  preserved in the `next` parameter (carried through the Google round-trip), so
  after signing in you land on the pre-filled form and can Send as usual.
- New users must click "Choose folder…" once before sending; the Send button is
  disabled until a Drive folder is stored.
- In local `wrangler dev`, open the app on `localhost` or `127.0.0.1`. The session
  cookie is `Secure` (and `__Host-` prefixed); browsers drop such cookies on other
  http hostnames (a LAN IP, a custom name), which shows up as a login loop.

## Legal pages

The Worker serves a Privacy Policy at `/privacy` and Terms of Use at `/terms`
(both public, no sign-in needed). Point the Google OAuth consent screen's privacy
policy link at `https://<your-worker>.workers.dev/privacy`. The favicon and brand
mark are a single SVG served at `/favicon.svg` (`src/assets.js`).

## License

MIT — see [LICENSE](LICENSE). Provided as-is, best effort, with no warranty.
