// The app UI: a login page and, for an authenticated session, the dashboard.
// Login is "Sign in with Google" (OAuth); the session is a signed cookie, so no
// credentials live in the page and the form's fetch and /jobs polling are
// same-origin and ride the cookie automatically. The dashboard shows a live list
// of recent jobs (all states), a Drive-folder picker (each user chooses where
// their EPUBs land), and a drag-to-bookmarks bookmarklet that opens the dashboard
// with the current URL pre-filled; the user clicks Send to enqueue (an explicit
// same-origin POST, which is what keeps it CSRF-safe).

import { LOGO_SVG } from "./assets.js";

// Where "Source" in the footer and the legal pages point people for questions,
// deletion requests, and the code itself.
const REPO_URL = "https://github.com/rraval/read-later";

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

// The wordmark: the bookmark logo inlined next to "Read Later". Used in the h1 on
// every page so the brand and the tab favicon (also LOGO_SVG) match.
function brand() {
  return `<span class="brand">${LOGO_SVG}Read Later</span>`;
}

// Shared page chrome so the dashboard and login look like one app. `head` allows
// extra tags (e.g. loading Google's Picker scripts on the dashboard only).
function page(title, body, head = "") {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="icon" type="image/svg+xml" href="/favicon.svg"/>
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  input[type=url] { width: 100%; padding: .6rem; font-size: 1rem; box-sizing: border-box; border: 1px solid rgba(128,128,128,.5); border-radius: .4rem; }
  button { padding: .6rem 1rem; font-size: 1rem; cursor: pointer; border: 1px solid currentColor; border-radius: .4rem; background: transparent; color: inherit; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .btn-primary { border: none; background: #2563eb; color: #fff; font-weight: 600; }
  .btn-primary:disabled { background: #2563eb; }
  a.btn { display: inline-block; padding: .6rem 1rem; border: 1px solid currentColor; border-radius: .4rem; text-decoration: none; margin-top: .6rem; }
  .bm { text-decoration: underline; }
  .muted { opacity: .7; font-size: .9rem; }
  .alert { color: #d33; margin-top: .6rem; }
  h1 a.bm { color: inherit; text-decoration: none; cursor: grab; }
  h1:has(a.bm) { display: flex; align-items: center; gap: .5rem; }
  .drag-hint { font-weight: 400; font-size: .8rem; }
  .actionbar { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; margin: -.5rem 0 1.5rem; }
  .actionbar a { color: inherit; }
  .compose { display: flex; gap: .5rem; flex-wrap: wrap; }
  .compose input[type=url] { flex: 1; min-width: 12rem; }
  .compose button { white-space: nowrap; }
  #status { margin-top: .6rem; min-height: 1.2rem; }
  #status.ok { color: #16a34a; opacity: 1; }
  .setup { padding: 1rem; margin-bottom: 1.5rem; border: 1px solid rgba(128,128,128,.4); border-radius: .5rem; background: rgba(37,99,235,.06); }
  .setup p { margin: 0 0 .6rem; }
  ul#jobs { list-style: none; padding: 0; margin: .5rem 0; }
  ul#jobs li { padding: .6rem 0; border-top: 1px solid rgba(128,128,128,.25); }
  .row { display: flex; justify-content: space-between; gap: 1rem; }
  .url { word-break: break-all; }
  .err { white-space: pre-wrap; word-break: break-word; margin-top: .2rem; }
  .linkbtn { background: none; border: none; padding: 0; font: inherit; color: inherit; text-decoration: underline; cursor: pointer; }
  .brand { display: inline-flex; align-items: center; gap: .5rem; }
  .brand svg { width: 1.25em; height: 1.25em; flex: none; }
  .site-foot { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid rgba(128,128,128,.25); text-align: center; font-size: .85rem; opacity: .7; }
  .site-foot a { color: inherit; }
  .legal { max-width: 40rem; }
  .legal h2 { margin-top: 1.8rem; }
  .legal p, .legal li { margin: .6rem 0; }
</style>${head}</head>
<body>
${body}
  <footer class="site-foot">
    <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="${REPO_URL}" target="_blank" rel="noopener">Source</a>
  </footer>
</body></html>`;
}

// The public landing page, served at both "/" (for logged-out visitors) and
// "/login". It doubles as the app's home page for Google's OAuth branding
// verification, so it must state the app's purpose and show the "Read Later"
// name that matches the OAuth consent screen. Rendered unauthenticated with no
// user data. `next` (where to land after login) is carried on the sign-in link
// and validated server-side with safeNext.
export function renderLanding(next) {
  const href = "/auth/login" + (next ? "?next=" + encodeURIComponent(next) : "");
  return page(
    "Read Later — Save web articles to your e-reader",
    `  <h1>${brand()}</h1>
  <p>Read Later turns any web article into a clean, clutter-free EPUB and saves it
  to a Google Drive folder you choose, so your e-reader can sync it and you can read
  it later, offline, on a proper screen.</p>

  <h2>How it works</h2>
  <ul>
    <li>Paste an article URL, or use the one-click bookmarklet from any page.</li>
    <li>Read Later fetches the page, strips out ads and navigation, and builds a
    readable EPUB.</li>
    <li>The EPUB lands in the Google Drive folder you pick; your e-reader syncs
    that folder and the article is waiting for you.</li>
  </ul>

  <p class="muted">Read Later only touches the Drive files and folder you choose
  (the <code>drive.file</code> scope), and it is free and open source.</p>

  <p><a class="btn" href="${esc(href)}">Sign in with Google</a></p>
  <p class="muted">Sign in with the Google account whose Drive should receive your articles.</p>`
  );
}

export function renderUI({ origin, clientId, apiKey, appId, folderName }) {
  // Bookmarklet: open this dashboard in a new tab with the current page's URL in
  // the query string, so the form arrives pre-filled. No fetch and no baked-in
  // credential; the enqueue is an explicit same-origin POST the user triggers by
  // clicking Send. Built with JSON.stringify so the origin is safely quoted
  // inside the javascript: URL.
  const bookmarklet =
    "javascript:window.open(" +
    JSON.stringify(origin + "/?url=") +
    "+encodeURIComponent(location.href),'_blank')";

  // Config the in-browser Picker needs. These are exposed to the page by design
  // (the OAuth client id, the referrer-restricted API key, and the numeric app
  // id). JSON.stringify keeps them safely quoted inside the inline script.
  const cfg = `const CLIENT_ID=${JSON.stringify(clientId || "")},API_KEY=${JSON.stringify(
    apiKey || ""
  )},APP_ID=${JSON.stringify(appId || "")};`;

  const head =
    '\n<script src="https://apis.google.com/js/api.js" async defer></script>' +
    '\n<script src="https://accounts.google.com/gsi/client" async defer></script>';

  return page(
    "Read Later",
    `  <h1><a class="bm" id="bm" href="${esc(bookmarklet)}" title="Drag me to your bookmarks bar to save any page in one click">${brand()}</a> <span class="drag-hint muted">← drag to bookmarks</span></h1>
  <p id="bm-note" class="muted" hidden>This is a bookmarklet — <strong>drag</strong> the “Read Later” title up to your bookmarks bar. Then, on any page you want to read later, click it to send the article here.</p>
  <div class="actionbar muted">
    <span id="folder">${
      folderName
        ? '📁 Saving to ' + esc(folderName) + ' · <button type="button" id="change" class="linkbtn">Change folder</button>'
        : '📁 No Drive folder chosen yet.'
    }</span>
    <a href="/logout">Sign out</a>
  </div>

  <div id="setup" class="setup"${folderName ? " hidden" : ""}>
    <p>Choose a Google Drive folder to start saving articles. Your EPUBs land there and your e-reader syncs them.</p>
    <button type="button" id="choose">Choose folder…</button>
  </div>

  <form id="f" class="compose">
    <input type="url" id="u" placeholder="Paste an article URL…" required autofocus/>
    <button type="submit" id="send" class="btn-primary"${folderName ? "" : " disabled"}>Send</button>
  </form>
  <div id="status"></div>

  <h2>Recent</h2>
  <ul id="jobs"><li class="muted">Loading…</li></ul>

  <script>
    ${cfg}
    const f = document.getElementById('f');
    const input = document.getElementById('u');
    const send = document.getElementById('send');
    const status = document.getElementById('status');
    const list = document.getElementById('jobs');
    const folderEl = document.getElementById('folder');
    const setupEl = document.getElementById('setup');
    let hasFolder = ${folderName ? "true" : "false"};

    // Clicking the title runs the bookmarklet against this very page, which is
    // never what someone wants here. Intercept the click and explain that it's
    // meant to be dragged to the bookmarks bar instead.
    document.getElementById('bm').addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('bm-note').hidden = false;
    });

    // Render the action-bar folder line. Built with textContent for the (untrusted)
    // folder name, plus a "Change folder" button that re-opens the Picker.
    function setFolderLine(name) {
      folderEl.textContent = '📁 Saving to ' + name + ' · ';
      const change = document.createElement('button');
      change.type = 'button';
      change.className = 'linkbtn';
      change.textContent = 'Change folder';
      change.addEventListener('click', pickFolder);
      folderEl.append(change);
    }

    const LABEL = {
      queued: ['⏳', 'Working…'],
      done: ['✓', 'Done'],
      dropped: ['⚠︎', 'Skipped — could not convert'],
      failed: ['✗', 'Failed after retries'],
    };

    function ago(ts) {
      const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
      if (s < 60) return s + 's ago';
      const m = Math.round(s / 60); if (m < 60) return m + 'm ago';
      const h = Math.round(m / 60); if (h < 24) return h + 'h ago';
      return Math.round(h / 24) + 'd ago';
    }

    // A cleared/expired session surfaces as a 401 on these same-origin fetches;
    // bounce to login, preserving where we are so a pending ?url= survives.
    function toLogin() {
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    }

    // --- Drive folder Picker ---
    // A fresh drive.file access token is minted in the browser via Google Identity
    // Services, so the long-lived refresh token never touches the page. The picked
    // folder is POSTed to /folder, where the server verifies its own refresh token
    // can see it before storing it.
    let tokenClient = null;
    function ensureTokenClient() {
      if (tokenClient) return true;
      if (!(window.google && google.accounts && google.accounts.oauth2)) return false;
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/drive.file',
        callback: (resp) => { if (resp && resp.access_token) openPicker(resp.access_token); },
      });
      return true;
    }
    function openPicker(accessToken) {
      gapi.load('picker', () => {
        const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
          .setSelectFolderEnabled(true)
          .setMimeTypes('application/vnd.google-apps.folder');
        const picker = new google.picker.PickerBuilder()
          .setAppId(APP_ID)
          .setOAuthToken(accessToken)
          .setDeveloperKey(API_KEY)
          .addView(view)
          .setCallback(onPicked)
          .build();
        picker.setVisible(true);
      });
    }
    async function onPicked(data) {
      if (!(window.google && google.picker) || data.action !== google.picker.Action.PICKED) return;
      const doc = data.docs && data.docs[0];
      if (!doc) return;
      folderEl.textContent = 'Saving folder…';
      try {
        const r = await fetch('/folder', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ folderId: doc.id }),
        });
        if (r.status === 401) return toLogin();
        const body = await r.json().catch(() => ({}));
        if (!r.ok) { folderEl.textContent = '✗ ' + (body.error || 'could not save folder'); return; }
        setFolderLine(body.name || doc.name || 'folder');
        hasFolder = true;
        send.disabled = false;
        setupEl.hidden = true;
        input.focus();
      } catch (err) {
        folderEl.textContent = '✗ Error: ' + err;
      }
    }
    // Open the Drive Picker. Wired to the first-run setup button and the action
    // bar's "Change folder" button, so both entry points share one code path.
    function pickFolder() {
      if (!ensureTokenClient()) { folderEl.textContent = 'Google not loaded yet — try again in a moment.'; return; }
      tokenClient.requestAccessToken();
    }
    document.getElementById('choose').addEventListener('click', pickFolder);
    document.querySelectorAll('#change').forEach((b) => b.addEventListener('click', pickFolder));

    // Build the list with textContent only: job URLs and percollate error text
    // are untrusted, so never route them through innerHTML.
    function render(jobs) {
      list.textContent = '';
      if (!jobs.length) {
        const li = document.createElement('li');
        li.className = 'muted';
        li.textContent = 'No articles yet.';
        list.append(li);
        return;
      }
      for (const j of jobs) {
        const [icon, label] = LABEL[j.state] || ['•', j.state];
        const li = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'row';
        const title = document.createElement('span');
        title.textContent = icon + ' ' + (j.state === 'done' && j.filename ? j.filename : label);
        const time = document.createElement('span');
        time.className = 'muted';
        time.textContent = ago(j.ts);
        row.append(title, time);
        const url = document.createElement('div');
        url.className = 'muted url';
        url.textContent = j.url || '';
        li.append(row, url);
        if ((j.state === 'dropped' || j.state === 'failed') && j.error) {
          const err = document.createElement('div');
          err.className = 'muted err';
          err.textContent = String(j.error).slice(0, 200);
          li.append(err);
        }
        // Failed/dropped jobs are recoverable: a Retry re-enqueues the same URL
        // (mints a new job; the old row stays until it self-prunes). Disable while
        // in flight; re-enable if the enqueue didn't take.
        if (j.state === 'failed' || j.state === 'dropped') {
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'linkbtn';
          retry.textContent = 'Retry';
          retry.addEventListener('click', async () => {
            retry.disabled = true;
            if (!(await enqueue(j.url))) retry.disabled = false;
          });
          li.append(retry);
        }
        list.append(li);
      }
    }

    let jobs = [];
    async function refresh() {
      try {
        const r = await fetch('/jobs');
        if (r.status === 401) return toLogin();
        if (r.ok) { jobs = await r.json(); render(jobs); }
      } catch {}
    }

    // Poll fast while something is converting, slowly when everything is settled,
    // and not at all while the tab is hidden, to keep the store reads minimal.
    const anyActive = () => jobs.some((j) => j.state === 'queued');
    let timer;
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(tick, anyActive() ? 4000 : 30000);
    }
    async function tick() {
      if (!document.hidden) await refresh();
      schedule();
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { refresh().then(schedule); }
    });

    let okTimer;
    // Shared enqueue path for both the compose form and the per-row Retry button
    // (retry just re-sends a failed/dropped job's URL — no dedicated endpoint).
    // Surfaces progress in #status, refreshes the list, and returns true on success.
    async function enqueue(url) {
      status.classList.remove('ok');
      clearTimeout(okTimer);
      if (!hasFolder) { status.textContent = 'Choose a Drive folder first.'; return false; }
      status.textContent = 'Queuing…';
      try {
        const r = await fetch('/enqueue', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        if (r.status === 401) { toLogin(); return false; }
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          status.textContent = body.error === 'no folder' ? '✗ Choose a Drive folder first.' : '✗ Failed: ' + r.status;
          return false;
        }
        status.classList.add('ok');
        status.textContent = '✓ Queued';
        okTimer = setTimeout(() => { status.classList.remove('ok'); status.textContent = ''; }, 2500);
        await refresh();
        schedule();
        return true;
      } catch (err) {
        status.textContent = '✗ Error: ' + err;
        return false;
      }
    }

    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (await enqueue(input.value)) {
        input.value = '';
        input.focus();
      }
    });

    // Pre-fill from a ?url= handed over by the bookmarklet, then strip it so a
    // reload doesn't re-fill. No auto-submit: the explicit Send click is the CSRF
    // defense (the enqueue only happens on a same-origin POST the user triggers).
    const pre = new URLSearchParams(location.search).get('url');
    if (pre) {
      input.value = pre;
      send.focus();
      history.replaceState(null, '', location.pathname);
    }

    refresh().then(schedule);
  </script>`,
    head
  );
}

// Static Privacy Policy. Reachable without a session (Google's OAuth consent
// screen links here, and the footer links here from every page). The text
// describes what the reference deployment actually does; keep it in sync with
// the data the Worker and Store DO handle if that changes.
export function renderPrivacy() {
  return page(
    "Read Later — Privacy",
    `  <h1>${brand()}</h1>
  <div class="legal">
  <h2>Privacy Policy</h2>
  <p class="muted">Last updated 7 July 2026</p>

  <p>Read Later is a free, open-source, self-hostable tool. This policy describes
  the reference deployment. If you run your own instance, you are the operator of
  that instance and responsible for its data. The software is provided as-is (see
  the <a href="/terms">Terms</a>).</p>

  <h2>What we store</h2>
  <ul>
    <li><strong>Your Google identity.</strong> When you sign in with Google we
    store your Google account identifier and email address (and whether Google
    reports it as verified). These are used only to sign you in and to check you
    against the access allowlist.</li>
    <li><strong>A Google Drive token.</strong> We store a Google Drive refresh
    token limited to the <code>drive.file</code> scope — it can only touch files
    and folders this app creates or that you explicitly pick. It is stored
    encrypted at rest and is used to upload your EPUBs to the folder you choose.</li>
    <li><strong>Your chosen folder.</strong> The id and name of the Google Drive
    folder you select as the upload destination.</li>
    <li><strong>Your recent jobs.</strong> For each article you submit we store
    the URL, its processing state, the resulting filename, and any error message.
    These rows live in per-user storage and are automatically deleted after about
    one week.</li>
    <li><strong>A session cookie.</strong> A signed, <code>Secure</code>,
    <code>HttpOnly</code>, <code>__Host-</code>-prefixed cookie keeps you logged
    in. There are no analytics, no advertising, and no third-party tracking
    cookies.</li>
  </ul>

  <h2>Who processes the data</h2>
  <p>To provide the service, data is processed by:</p>
  <ul>
    <li><strong>Cloudflare</strong> — hosting, the job queue, storage, and the
    container that converts pages into EPUBs. The application runs entirely on
    Cloudflare's platform.</li>
    <li><strong>Google</strong> — sign-in (OAuth) and the Drive API used to
    upload your files.</li>
    <li><strong>The website you submit</strong> — the converter fetches each URL
    you send directly from its origin server to build the EPUB.</li>
  </ul>
  <p>Data is not sold, rented, or shared beyond what is needed to run the service.</p>

  <h2>Your controls</h2>
  <ul>
    <li>You can revoke this app's access to your Google account at any time from
    your <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener">Google
    Account permissions</a>.</li>
    <li>Signing out clears your session. Your job history deletes itself after
    about a week.</li>
    <li>The EPUBs live in your own Google Drive and remain under your control.</li>
    <li>For deletion requests or questions, open an issue at
    <a href="${REPO_URL}" target="_blank" rel="noopener">${esc(REPO_URL)}</a>.</li>
  </ul>

  <p class="muted">This service is not directed to children.</p>
  </div>`
  );
}

// Static Terms of Use. Best-effort, minimal-warranty framing to match the
// free/libre spirit of the project. Reachable without a session; linked from the
// footer of every page.
export function renderTerms() {
  return page(
    "Read Later — Terms",
    `  <h1>${brand()}</h1>
  <div class="legal">
  <h2>Terms of Use</h2>
  <p class="muted">Last updated 7 July 2026</p>

  <p>Read Later converts web article URLs into EPUB files and uploads them to a
  Google Drive folder you choose. Access to the hosted instance is limited to
  allowlisted accounts and intended for personal use. By using it you agree to
  these terms.</p>

  <h2>Acceptable use</h2>
  <ul>
    <li>Only submit URLs you are entitled to access.</li>
    <li>Respect copyright and the terms of the websites you convert. You are
    responsible for the content you process and for how you use the resulting
    files.</li>
    <li>Do not use the service to infringe others' rights or to place undue load
    on any website.</li>
  </ul>

  <h2>Open source</h2>
  <p>The software is open source, licensed under the MIT License. You are free to
  read, run, modify, and self-host it. The source and license are at
  <a href="${REPO_URL}" target="_blank" rel="noopener">${esc(REPO_URL)}</a>.
  These terms govern use of this hosted instance, not the software itself.</p>

  <h2>No warranty</h2>
  <p>The service is provided "as is" and "as available", on a best-effort basis,
  without warranties of any kind, express or implied. There is no guarantee of
  availability, of the accuracy or completeness of conversions, or of data
  retention. The service may change, break, or be discontinued at any time
  without notice.</p>

  <h2>Limitation of liability</h2>
  <p>To the maximum extent permitted by law, the operator and contributors are not
  liable for any damages arising from your use of the service, including lost or
  corrupted data or failed or inaccurate conversions.</p>

  <h2>Third-party services</h2>
  <p>Your use also depends on and is subject to the terms of Google and Cloudflare.</p>

  <h2>Contact</h2>
  <p>Questions and reports: <a href="${REPO_URL}" target="_blank" rel="noopener">${esc(REPO_URL)}</a>.</p>
  </div>`
  );
}
