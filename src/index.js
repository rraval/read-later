import { Container, getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { renderUI } from "./ui.js";
import { uploadToDrive } from "./drive.js";

// Durable-Object-backed container that turns a URL into a self-contained,
// offline-readable document (currently an EPUB built by percollate). The class
// name reflects that responsibility, not the tool: the Worker depends only on the
// container's HTTP contract (POST /convert {url} -> document bytes + x-filename),
// so the converter can be swapped out (Dockerfile + container/server.mjs) without
// touching this binding or needing a Durable Object migration.
export class Archiver extends Container {
  defaultPort = 8080;
  sleepAfter = "10m"; // keep warm briefly so bursts reuse a hot Chromium
}

// Job status store. A dedicated, tiny SQLite-backed Durable Object (deliberately
// NOT the Archiver container DO, to keep the container's lifecycle and the
// converter/status concerns separate). Chosen over KV because it needs no
// namespace-create step, is strongly consistent (a poll right after enqueue sees
// the latest write), and reuses infra this Worker already depends on. All jobs
// live in one singleton instance (see jobStore); single-user volume never
// outgrows one DO. States: queued -> done | dropped (permanent) | failed (DLQ).
export class JobStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, url TEXT, state TEXT, error TEXT, filename TEXT, ts INTEGER)"
    );
  }

  put(job) {
    // Self-pruning: drop records older than a week on each write so the table
    // stays tiny without a scheduled job. Cheap at this volume.
    const now = Date.now();
    this.sql.exec("DELETE FROM jobs WHERE ts < ?", now - 7 * 24 * 3600 * 1000);
    this.sql.exec(
      "INSERT OR REPLACE INTO jobs (id, url, state, error, filename, ts) VALUES (?, ?, ?, ?, ?, ?)",
      job.id,
      job.url ?? null,
      job.state,
      job.error ?? null,
      job.filename ?? null,
      now
    );
  }

  list(limit = 25) {
    return this.sql.exec("SELECT * FROM jobs ORDER BY ts DESC LIMIT ?", limit).toArray();
  }
}

// Single shared instance keyed by a fixed name: all job rows live together, and
// reads/writes serialize through one DO (fine for one low-volume user).
function jobStore(env) {
  return env.JOB_STORE.get(env.JOB_STORE.idFromName("jobs"));
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function authed(req, env) {
  const header = req.headers.get("authorization") || "";
  // BASIC_USER/BASIC_PASS must be ASCII: btoa throws on non-Latin1 input.
  const expected = "Basic " + btoa(`${env.BASIC_USER}:${env.BASIC_PASS}`);
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function unauthorized() {
  return new Response("Authentication required.", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="read-later"' },
  });
}

// Reject anything that isn't a plain http(s) URL to a public host, so an enqueued
// URL can't make the container fetch internal addresses (cloud metadata at
// 169.254.169.254, loopback, RFC1918, link-local). Limitation: a public hostname
// that later resolves to a private IP (DNS rebinding) is not caught — acceptable
// for a single-user tool.
export function isAllowedTarget(urlString) {
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
    if (a === 0 || a === 10 || a === 127) return false; // this-network, RFC1918, loopback
    if (a === 169 && b === 254) return false; // link-local incl. metadata
    if (a === 192 && b === 168) return false; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
    return true;
  }
  if (host.includes(":")) {
    // IPv6 literal
    if (host === "::" || host === "::1") return false; // unspecified, loopback
    if (host.startsWith("fc") || host.startsWith("fd")) return false; // unique-local fc00::/7
    if (host.startsWith("fe80")) return false; // link-local
    return true;
  }
  return true; // a DNS hostname
}

function safeName(name) {
  // Input is always an EPUB from the container; keep the .epub suffix and only
  // sanitize/truncate the base so a long title can't lose its extension.
  const base = (name || "").trim().replace(/\.epub$/i, "");
  const clean = base
    .replace(/[\/\\?%*:|"<>\x00-\x1f]/g, "-")
    .slice(0, 150)
    .replace(/[-.\s]+$/, "");
  return (clean || "article") + ".epub";
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
      } catch {
        target = undefined;
      }
      if (!isAllowedTarget(target)) {
        return new Response(JSON.stringify({ error: "invalid url" }), {
          status: 400,
          headers: { ...CORS, "content-type": "application/json" },
        });
      }
      const jobId = crypto.randomUUID();
      await jobStore(env).put({ id: jobId, url: target, state: "queued" });
      await env.QUEUE.send({ url: target, jobId });
      return new Response(JSON.stringify({ ok: true, jobId }), {
        headers: { ...CORS, "content-type": "application/json" },
      });
    }

    if (req.method === "GET" && url.pathname === "/jobs") {
      const jobs = await jobStore(env).list();
      return new Response(JSON.stringify(jobs), {
        headers: { ...CORS, "content-type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async queue(batch, env) {
    // The DLQ receives only messages that exhausted every retry on the main
    // queue. Recording them as "failed" (instead of Cloudflare silently deleting
    // them) is the whole reason the DLQ exists: nothing vanishes, and the URL is
    // preserved in the job record for a manual re-enqueue.
    if (batch.queue === "read-later-dlq") {
      for (const msg of batch.messages) {
        const { url, jobId } = msg.body;
        console.error(`dead-letter ${url}: retries exhausted`);
        await jobStore(env).put({ id: jobId, url, state: "failed", error: "retries exhausted" });
        msg.ack();
      }
      return;
    }

    for (const msg of batch.messages) {
      const { url, jobId } = msg.body;
      try {
        console.log(`converting ${url}`);
        const container = getContainer(env.ARCHIVER);
        const resp = await container.fetch(
          new Request("http://archiver/convert", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url }),
          })
        );
        if (!resp.ok) {
          const detail = `${resp.status} ${await resp.text()}`;
          // 4xx means the URL is bad, blocked, or unconvertible: permanent, so
          // drop it instead of burning two more container spins on retries.
          if (resp.status >= 400 && resp.status < 500) {
            console.error(`dropping ${url}: convert rejected ${detail}`);
            await jobStore(env).put({ id: jobId, url, state: "dropped", error: detail });
            msg.ack();
            continue;
          }
          throw new Error(`convert failed: ${detail}`);
        }

        const filename = safeName(decodeURIComponent(resp.headers.get("x-filename") || "article.epub"));
        const bytes = new Uint8Array(await resp.arrayBuffer());
        const result = await uploadToDrive(env, filename, bytes);
        console.log(`uploaded ${filename} (${bytes.length} bytes) as ${result.id}`);
        await jobStore(env).put({ id: jobId, url, state: "done", filename });
        msg.ack();
      } catch (err) {
        // Transient: let the queue retry. Deliberately no status write, so the
        // record stays "queued" and the UI keeps showing "working". If every
        // retry fails, the message lands on the DLQ and is marked "failed" there.
        console.error(`failed ${url}: ${err.stack || err}`);
        msg.retry();
      }
    }
  },
};
