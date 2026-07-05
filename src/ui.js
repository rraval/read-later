// The enqueue UI. Rendered only after Basic auth succeeds, so we can safely bake
// the caller's own Authorization header into the page: it powers both the form's
// fetch and a drag-to-bookmarks bookmarklet that works from any site.

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

export function renderUI(authHeader, origin) {
  const auth = esc(authHeader || "");
  const enqueueUrl = `${origin}/enqueue`;

  // Bookmarklet: POST the current tab's URL with the baked-in auth header.
  const bookmarklet =
    "javascript:(function(){fetch(" +
    JSON.stringify(enqueueUrl) +
    ",{method:'POST',headers:{authorization:" +
    JSON.stringify(authHeader || "") +
    ",'content-type':'application/json'},body:JSON.stringify({url:location.href})}).then(function(r){alert(r.ok?'Sent to Supernote':'Failed: '+r.status)}).catch(function(e){alert('Error: '+e)})})()";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Read Later → Supernote</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  input[type=url] { width: 100%; padding: .6rem; font-size: 1rem; box-sizing: border-box; }
  button { padding: .6rem 1rem; font-size: 1rem; margin-top: .6rem; cursor: pointer; }
  .bm { display: inline-block; padding: .4rem .8rem; border: 1px solid currentColor; border-radius: .4rem; text-decoration: none; }
  .muted { opacity: .7; font-size: .9rem; }
  #status { margin-top: 1rem; min-height: 1.2rem; }
  code { background: rgba(128,128,128,.2); padding: .1rem .3rem; border-radius: .2rem; }
</style></head>
<body>
  <h1>Read Later → Supernote</h1>
  <form id="f">
    <input type="url" id="u" placeholder="https://example.com/article" required autofocus/>
    <button type="submit">Send to Supernote</button>
  </form>
  <div id="status" class="muted"></div>

  <h2>Bookmarklet</h2>
  <p class="muted">Drag this to your bookmarks bar, then click it on any page to send it:</p>
  <p><a class="bm" href="${esc(bookmarklet)}">📖 Read Later</a></p>

  <script>
    const AUTH = ${JSON.stringify(authHeader || "")};
    const f = document.getElementById('f');
    const status = document.getElementById('status');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = document.getElementById('u').value;
      status.textContent = 'Queuing…';
      try {
        const r = await fetch(${JSON.stringify(enqueueUrl)}, {
          method: 'POST',
          headers: { authorization: AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        status.textContent = r.ok ? '✓ Queued. It will appear after the next Supernote sync.' : '✗ Failed: ' + r.status;
        if (r.ok) document.getElementById('u').value = '';
      } catch (err) {
        status.textContent = '✗ Error: ' + err;
      }
    });
  </script>
</body></html>`;
}
