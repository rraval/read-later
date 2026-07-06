// The app UI: a login page and, for an authenticated session, the dashboard.
// Login is "Sign in with Google" (OAuth); the session is a signed cookie, so no
// credentials live in the page and the form's fetch and /jobs polling are
// same-origin and ride the cookie automatically. The dashboard shows a live list
// of recent jobs (all states), a Drive-folder picker (each user chooses where
// their EPUBs land), and a drag-to-bookmarks bookmarklet that opens the dashboard
// with the current URL pre-filled; the user clicks Send to enqueue (an explicit
// same-origin POST, which is what keeps it CSRF-safe).

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

// Shared page chrome so the dashboard and login look like one app. `head` allows
// extra tags (e.g. loading Google's Picker scripts on the dashboard only).
function page(title, body, head = "") {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
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
  .topbar { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; margin-bottom: 1.5rem; }
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
  .foot { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid rgba(128,128,128,.25); }
  .foot p { margin: .4rem 0; }
  .linkbtn { background: none; border: none; padding: 0; font: inherit; color: inherit; text-decoration: underline; cursor: pointer; }
</style>${head}</head>
<body>
${body}
</body></html>`;
}

// "Sign in with Google" login. Rendered unauthenticated with no user data. `next`
// (where to land after login) is carried on the sign-in link and validated
// server-side with safeNext.
export function renderLogin(next) {
  const href = "/auth/login" + (next ? "?next=" + encodeURIComponent(next) : "");
  return page(
    "Read Later — Sign in",
    `  <h1>Read Later</h1>
  <p class="muted">Sign in with the Google account whose Drive should receive your articles.</p>
  <p><a class="btn" href="${esc(href)}">Sign in with Google</a></p>`
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
    `  <div class="topbar"><h1>Read Later</h1><a class="muted" href="/logout">Sign out</a></div>

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

  <div class="foot muted">
    <p id="folder">${
      folderName
        ? '📁 Saving to ' + esc(folderName) + ' · <button type="button" id="change" class="linkbtn">Change folder</button>'
        : '📁 No Drive folder chosen yet.'
    }</p>
    <p>Or drag <a class="bm" href="${esc(bookmarklet)}">📖 Read Later</a> to your bookmarks bar to save any page in one click.</p>
  </div>

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

    // Render the footer folder line. Built with textContent for the (untrusted)
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
    // Open the Drive Picker. Wired to the first-run setup button and the footer's
    // "Change folder" button, so both entry points share one code path.
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
