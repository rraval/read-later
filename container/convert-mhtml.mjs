// CLI: convert a Chrome "Save Page As → Webpage, Single File" capture into an
// EPUB with the same percollate pipeline server.mjs uses for URLs. Meant to run
// inside the container image via the ./mhtml2epub wrapper at the repo root:
//
//   node convert-mhtml.mjs <input.mhtml> [output-dir]
//
// percollate reads the extracted HTML from a local file, but its EPUB step
// fetches every image over HTTP (node-fetch can't read file paths), so the
// capture's images are served from memory on an ephemeral localhost port for
// the duration of the run. Images the capture doesn't contain keep their
// original remote URLs and are fetched best-effort, exactly like the URL flow.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { extensionForMime, parseMhtml, rewriteReferences } from "./mhtml.mjs";

const execFileP = promisify(execFile);
const CONVERT_TIMEOUT_MS = 300000; // large captures + Chromium can be slow

function isHttpUrl(s) {
  try {
    const p = new URL(s).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

async function main() {
  const [input, outDirArg] = process.argv.slice(2);
  if (!input) {
    console.error("usage: node convert-mhtml.mjs <input.mhtml> [output-dir]");
    process.exit(2);
  }
  const outDir = resolve(outDirArg || dirname(resolve(input)));
  const { rootHtml, rootLocation, assets } = parseMhtml(await readFile(input));

  // Serve the capture's images by exact registered name only — request URLs
  // never touch the filesystem.
  const served = new Map();
  const server = createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname.slice(1));
    const asset = served.get(name);
    if (!asset) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": asset.mime, "content-length": asset.bytes.length });
    res.end(asset.bytes);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;

  const dir = await mkdtemp(join(tmpdir(), "mhtml-"));
  try {
    const replacements = assets.map((asset, i) => {
      const name = i + extensionForMime(asset.mime);
      served.set(name, asset);
      return { from: asset.location, to: `http://127.0.0.1:${port}/${name}` };
    });
    await writeFile(join(dir, "index.html"), rewriteReferences(rootHtml, replacements));

    // --url makes the original page the base URL (relative links, byline) and
    // percollate names the EPUB after the article title, same as the URL flow.
    // cwd is the temp dir so the title-named output can't collide with or be
    // confused for anything pre-existing in outDir.
    const args = ["epub", "--no-sandbox"];
    if (isHttpUrl(rootLocation)) args.push("--url", rootLocation);
    args.push(join(dir, "index.html"));
    await execFileP("percollate", args, {
      cwd: dir,
      timeout: CONVERT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });

    const epubs = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".epub"));
    if (epubs.length === 0) throw new Error("percollate produced no .epub");
    // copyFile, not rename: outDir is typically a Docker bind mount on a
    // different filesystem than the temp dir.
    const outPath = join(outDir, epubs[0]);
    await copyFile(join(dir, epubs[0]), outPath);
    console.log(outPath);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(String(err && err.message ? err.message : err));
  if (err && err.stderr) console.error(String(err.stderr));
  process.exit(1);
});
