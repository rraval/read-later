// Minimal HTTP server (no deps) that turns a URL into an EPUB with percollate.
// POST /convert {"url": "..."} -> 200 application/epub+zip, X-Filename header.
// Status codes tell the Worker how to treat a failure: 400 bad/blocked request,
// 422 unconvertible URL (permanent, drop it), 500 transient (retry).
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const PORT = 8080;
const CONVERT_TIMEOUT_MS = 120000;

// Defense-in-depth copy of the Worker's isAllowedTarget (src/index.js): the
// container is only reachable via the Worker, but this guarantees it never
// fetches a private/loopback/link-local address even if called directly. Kept in
// sync by hand — the container image can't import from src/.
function isAllowedTarget(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const oct = v4.slice(1).map(Number);
    if (oct.some((n) => n > 255)) return false;
    const [a, b] = oct;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    return true;
  }
  if (host.includes(":")) {
    if (host === "::" || host === "::1") return false;
    if (host.startsWith("fc") || host.startsWith("fd")) return false;
    if (host.startsWith("fe80")) return false;
    return true;
  }
  return true;
}

async function convert(url) {
  const dir = await mkdtemp(join(tmpdir(), "epub-"));
  try {
    // No -o: percollate names the file after the article title, which we reuse
    // as the Drive filename. --no-sandbox is required to run Chromium as root.
    await execFileP("percollate", ["epub", "--no-sandbox", url], {
      cwd: dir,
      timeout: CONVERT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    const epubs = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".epub"));
    if (epubs.length === 0) throw new Error("percollate produced no .epub");
    const filename = epubs[0];
    const bytes = await readFile(join(dir, filename));
    return { filename, bytes };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method === "POST" && req.url === "/convert") {
    let url;
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      url = JSON.parse(body || "{}").url;
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("invalid JSON body");
      return;
    }
    if (!isAllowedTarget(url)) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("invalid or disallowed url");
      return;
    }
    try {
      const { filename, bytes } = await convert(url);
      res.writeHead(200, {
        "content-type": "application/epub+zip",
        "x-filename": encodeURIComponent(filename),
        "content-length": bytes.length,
      });
      res.end(bytes);
    } catch (err) {
      // A timeout / killed process may be transient (huge page, OOM) -> 500 so
      // the queue retries. Anything else (unreadable page, no EPUB produced) is
      // permanent for this URL -> 422 so the queue drops it after logging.
      const transient = err && (err.killed || err.signal || err.code === "ETIMEDOUT");
      res.writeHead(transient ? 500 : 422, { "content-type": "text/plain" });
      res.end(String(err && err.stack ? err.stack : err));
    }
    return;
  }
  res.writeHead(404).end("not found");
});

server.listen(PORT, () => console.log(`percollate container listening on :${PORT}`));
