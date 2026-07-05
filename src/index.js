import { Container, getContainer } from "@cloudflare/containers";
import { renderUI } from "./ui.js";
import { uploadToDrive } from "./drive.js";

// Durable-Object-backed container running percollate. The base Container class
// proxies fetch() through to the app listening on defaultPort inside the image.
export class Percollate extends Container {
  defaultPort = 8080;
  sleepAfter = "10m"; // keep warm briefly so bursts reuse a hot Chromium
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function authed(req, env) {
  const header = req.headers.get("authorization") || "";
  const expected = "Basic " + btoa(`${env.BASIC_USER}:${env.BASIC_PASS}`);
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function unauthorized() {
  return new Response("Authentication required.", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="supernote-read-later"' },
  });
}

function safeName(name) {
  return (name || "article.epub").replace(/[\/\\?%*:|"<>\x00-\x1f]/g, "-").slice(0, 160) || "article.epub";
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (!authed(req, env)) return unauthorized();

    if (req.method === "GET" && url.pathname === "/") {
      return new Response(renderUI(req.headers.get("authorization"), url.origin), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (req.method === "POST" && url.pathname === "/enqueue") {
      let target;
      try {
        target = (await req.json()).url;
        new URL(target);
      } catch {
        return new Response(JSON.stringify({ error: "invalid url" }), {
          status: 400,
          headers: { ...CORS, "content-type": "application/json" },
        });
      }
      await env.QUEUE.send({ url: target });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS, "content-type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async queue(batch, env) {
    for (const msg of batch.messages) {
      const { url } = msg.body;
      try {
        console.log(`converting ${url}`);
        const container = getContainer(env.PERCOLLATE);
        const resp = await container.fetch(
          new Request("http://percollate/convert", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url }),
          })
        );
        if (!resp.ok) throw new Error(`convert failed: ${resp.status} ${await resp.text()}`);

        const filename = safeName(decodeURIComponent(resp.headers.get("x-filename") || "article.epub"));
        const bytes = new Uint8Array(await resp.arrayBuffer());
        const result = await uploadToDrive(env, filename, bytes);
        console.log(`uploaded ${filename} (${bytes.length} bytes) as ${result.id}`);
        msg.ack();
      } catch (err) {
        console.error(`failed ${url}: ${err.stack || err}`);
        msg.retry();
      }
    }
  },
};
