# read-later

One-click read-later. Send a URL, get a clean EPUB in a Google Drive folder that
an e-reader (e.g. a Supernote) syncs. Each person signs in with Google and picks
their own destination folder.

Flow: UI or bookmarklet → Cloudflare Worker (`/enqueue`) → Cloudflare Queue →
consumer calls a Cloudflare Container running [percollate](https://github.com/danburzo/percollate),
which fetches the page, runs Readability, embeds images, and builds the EPUB →
Worker uploads it to the signed-in user's chosen Drive folder using their own
credentials.

## Why this design

- percollate is the whole extract-and-package pipeline off the shelf, so there
  is almost no custom conversion code to maintain.
- The container gives percollate the real Node + Chromium environment it needs.
- The queue makes the UI return instantly and retries failures.

Cloudflare Containers require the Workers Paid plan, so this is not free-tier
eligible.

## Layout

- `src/index.js` — Worker entry: OAuth login and cookie sessions, routes, the
  queue consumer, the container class, and the `Store` Durable Object (users and
  per-user job status).
- `src/ui.js` — sign-in page, dashboard, Drive folder Picker, bookmarklet.
- `src/drive.js` — Drive upload and folder lookup, per-user credentials.
- `container/server.mjs`, `Dockerfile` — HTTP server plus the percollate +
  Chromium runtime it shells out to.

## Setup

Prereqs: Node 18+, Docker (for building the container image locally), a
Cloudflare account on Workers Paid, a Google account whose Drive the e-reader
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

Secrets live in one gitignored `.env` that you build up over the steps below. The
same file is loaded by `.envrc` for the setup scripts, by `wrangler dev` for
local runs, and uploaded to the Worker via `wrangler secret bulk .env`. Run
`direnv reload` if a script reports a missing variable.

### 1. Google Cloud project

Users sign in with Google; the app stores each user's Drive `drive.file` refresh
token (encrypted) and the folder they pick via the Google Picker. Access is
gated by an email allowlist.

1. Google Cloud console: create a project, and enable both the Google Drive API
   and the Google Picker API (two separate toggles).
2. OAuth consent screen: set the user type to External and add your app's brand
   details. Add the scopes `openid`, `email`, `profile`, and
   `.../auth/drive.file`. These are non-sensitive, so this needs only basic
   OAuth App Verification, not the restricted-scope CASA security assessment.
3. Publish the consent screen to Production (do not leave it in Testing). In
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

## The dashboard

The home page is a live dashboard: a form to send a URL plus an auto-polling list
of recent jobs, each shown as working, done, skipped, or failed. The bookmarklet
opens it with the URL pre-filled; you click Send to enqueue and the list updates
in place. Job state lives per-user in the `Store` Durable Object and expires
after a week. Jobs that fail every retry are kept, with the URL and error, and
get a Retry button rather than being dropped silently.

## Known limitations

- Paywalled or JS-heavy sites may extract poorly; these are recorded as `dropped`
  so the dashboard tells you rather than retrying forever.
- New users must pick a Drive folder once before the Send button enables.
- For local `wrangler dev`, open the app on `localhost` or `127.0.0.1`: the
  session cookie is `Secure` and `__Host-` prefixed, so browsers drop it on other
  http hostnames (a LAN IP, a custom name), which looks like a login loop.

## Legal pages

The Worker serves a Privacy Policy at `/privacy` and Terms of Use at `/terms`
(both public, no sign-in needed).

## License

MIT — see [LICENSE](LICENSE). Provided as-is, best effort, with no warranty.
