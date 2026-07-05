// Minimal HTTP server (no deps) that turns a URL into an EPUB with percollate.
// POST /convert {"url": "..."} -> 200 application/epub+zip, X-Filename header.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const PORT = 8080;
const CONVERT_TIMEOUT_MS = 120000;

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
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { url } = JSON.parse(body || "{}");
      new URL(url); // validate
      const { filename, bytes } = await convert(url);
      res.writeHead(200, {
        "content-type": "application/epub+zip",
        "x-filename": encodeURIComponent(filename),
        "content-length": bytes.length,
      });
      res.end(bytes);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(err && err.stack ? err.stack : err));
    }
    return;
  }
  res.writeHead(404).end("not found");
});

server.listen(PORT, () => console.log(`percollate container listening on :${PORT}`));
