// The app UI: a login page and, for an authenticated session, the dashboard.
// Auth is a session cookie, so no credentials live in the page: the form's fetch
// and the /jobs polling are same-origin and ride the cookie automatically. The
// dashboard shows a live list of recent jobs (all states), which for a low-volume
// single-user tool is more useful than a one-shot per-job status page. A
// drag-to-bookmarks bookmarklet opens the dashboard with the current URL
// pre-filled into the form; the user clicks Send to enqueue (an explicit
// same-origin POST, which is what keeps it CSRF-safe).

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

// Shared page chrome so the dashboard and login look like one app.
function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  input[type=url], input[type=password] { width: 100%; padding: .6rem; font-size: 1rem; box-sizing: border-box; }
  button { padding: .6rem 1rem; font-size: 1rem; margin-top: .6rem; cursor: pointer; }
  .bm { display: inline-block; padding: .4rem .8rem; border: 1px solid currentColor; border-radius: .4rem; text-decoration: none; }
  .muted { opacity: .7; font-size: .9rem; }
  .alert { color: #d33; margin-top: .6rem; }
  #status { margin-top: .6rem; min-height: 1.2rem; }
  ul#jobs { list-style: none; padding: 0; margin: .5rem 0; }
  ul#jobs li { padding: .6rem 0; border-top: 1px solid rgba(128,128,128,.25); }
  .row { display: flex; justify-content: space-between; gap: 1rem; }
  .url { word-break: break-all; }
  .err { white-space: pre-wrap; word-break: break-word; margin-top: .2rem; }
</style></head>
<body>
${body}
</body></html>`;
}

// Password-only login. Rendered unauthenticated with no job data. `next` is
// reflected into a hidden field, so it must be escaped (the server also validates
// it with safeNext on submit).
export function renderLogin(next, error) {
  return page(
    "Read Later — Log in",
    `  <h1>Read Later</h1>
  <form method="POST" action="/login">
    <input type="hidden" name="next" value="${esc(next || "/")}"/>
    <input type="password" name="password" placeholder="Password" autofocus required/>
    <button type="submit">Log in</button>
  </form>${error ? `\n  <p class="alert">${esc(error)}</p>` : ""}`
  );
}

export function renderUI(origin) {
  // Bookmarklet: open this dashboard in a new tab with the current page's URL in
  // the query string, so the form arrives pre-filled. No fetch and no baked-in
  // credential; the enqueue is an explicit same-origin POST the user triggers by
  // clicking Send. Built with JSON.stringify so the origin is safely quoted
  // inside the javascript: URL.
  const bookmarklet =
    "javascript:window.open(" +
    JSON.stringify(origin + "/?url=") +
    "+encodeURIComponent(location.href),'_blank')";

  return page(
    "Read Later",
    `  <h1>Read Later</h1>
  <form id="f">
    <input type="url" id="u" placeholder="https://example.com/article" required autofocus/>
    <button type="submit" id="send">Send</button>
  </form>
  <div id="status" class="muted"></div>

  <h2>Recent</h2>
  <ul id="jobs"><li class="muted">Loading…</li></ul>

  <h2>Bookmarklet</h2>
  <p class="muted">Drag this to your bookmarks bar, then click it on any page to open a pre-filled form:</p>
  <p><a class="bm" href="${esc(bookmarklet)}">📖 Read Later</a></p>

  <script>
    const f = document.getElementById('f');
    const input = document.getElementById('u');
    const send = document.getElementById('send');
    const status = document.getElementById('status');
    const list = document.getElementById('jobs');

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
    // and not at all while the tab is hidden, to keep the job-store reads minimal.
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

    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      status.textContent = 'Queuing…';
      try {
        const r = await fetch('/enqueue', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: input.value }),
        });
        if (r.status === 401) return toLogin();
        if (!r.ok) { status.textContent = '✗ Failed: ' + r.status; return; }
        input.value = '';
        status.textContent = '';
        await refresh();
        schedule();
      } catch (err) {
        status.textContent = '✗ Error: ' + err;
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
  </script>`
  );
}
