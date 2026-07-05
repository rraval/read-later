// The dashboard UI. Rendered only after Basic auth succeeds, so we can safely
// bake the caller's own Authorization header into the page: it powers the form's
// fetch, the /jobs polling, and a drag-to-bookmarks bookmarklet that works from
// any site. The page shows a live list of recent jobs (all states), which for a
// low-volume single-user tool is more useful than a one-shot per-job status page.

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

export function renderUI(authHeader, origin) {
  const enqueueUrl = `${origin}/enqueue`;

  // Bookmarklet: open the dashboard in a new tab (synchronously, so the click
  // gesture isn't lost and the popup isn't blocked), then enqueue the current
  // tab's URL with the baked-in auth header. The enqueue rides its own fetch, so
  // it succeeds even if the new tab has to re-auth; the tab is just for viewing.
  const bookmarklet =
    "javascript:(function(){window.open(" +
    JSON.stringify(origin) +
    ",'_blank');fetch(" +
    JSON.stringify(enqueueUrl) +
    ",{method:'POST',headers:{authorization:" +
    JSON.stringify(authHeader || "") +
    ",'content-type':'application/json'},body:JSON.stringify({url:location.href})}).catch(function(e){alert('Read Later error: '+e)})})()";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Read Later</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  input[type=url] { width: 100%; padding: .6rem; font-size: 1rem; box-sizing: border-box; }
  button { padding: .6rem 1rem; font-size: 1rem; margin-top: .6rem; cursor: pointer; }
  .bm { display: inline-block; padding: .4rem .8rem; border: 1px solid currentColor; border-radius: .4rem; text-decoration: none; }
  .muted { opacity: .7; font-size: .9rem; }
  #status { margin-top: .6rem; min-height: 1.2rem; }
  ul#jobs { list-style: none; padding: 0; margin: .5rem 0; }
  ul#jobs li { padding: .6rem 0; border-top: 1px solid rgba(128,128,128,.25); }
  .row { display: flex; justify-content: space-between; gap: 1rem; }
  .url { word-break: break-all; }
  .err { white-space: pre-wrap; word-break: break-word; margin-top: .2rem; }
</style></head>
<body>
  <h1>Read Later</h1>
  <form id="f">
    <input type="url" id="u" placeholder="https://example.com/article" required autofocus/>
    <button type="submit">Send</button>
  </form>
  <div id="status" class="muted"></div>

  <h2>Recent</h2>
  <ul id="jobs"><li class="muted">Loading…</li></ul>

  <h2>Bookmarklet</h2>
  <p class="muted">Drag this to your bookmarks bar, then click it on any page to send it:</p>
  <p><a class="bm" href="${esc(bookmarklet)}">📖 Read Later</a></p>

  <script>
    const AUTH = ${JSON.stringify(authHeader || "")};
    const ENQUEUE = ${JSON.stringify(enqueueUrl)};
    const JOBS = ${JSON.stringify(origin + "/jobs")};
    const f = document.getElementById('f');
    const input = document.getElementById('u');
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
        const r = await fetch(JOBS, { headers: { authorization: AUTH } });
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
        const r = await fetch(ENQUEUE, {
          method: 'POST',
          headers: { authorization: AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ url: input.value }),
        });
        if (!r.ok) { status.textContent = '✗ Failed: ' + r.status; return; }
        input.value = '';
        status.textContent = '';
        await refresh();
        schedule();
      } catch (err) {
        status.textContent = '✗ Error: ' + err;
      }
    });

    refresh().then(schedule);
  </script>
</body></html>`;
}
