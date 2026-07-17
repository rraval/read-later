import { Container, getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { renderUI, renderLanding, renderPrivacy, renderTerms } from "./ui.js";
import { LOGO_SVG } from "./assets.js";
import { uploadToDrive, getDriveFile } from "./drive.js";

// Durable-Object-backed container that turns a URL into a self-contained,
// offline-readable document (currently an EPUB built by percollate). The class
// name reflects that responsibility, not the tool: the Worker depends only on the
// container's HTTP contract (POST /convert {url} -> document bytes + x-filename),
// so the converter can be swapped out (Dockerfile + container/server.mjs) without
// touching this binding or needing a Durable Object migration.
export class Archiver extends Container {
  defaultPort = 8080;
  sleepAfter = "1m"; // keep warm briefly so bursts reuse a hot Chromium
}

// The app's persistent state: a single, tiny SQLite-backed Durable Object
// (deliberately NOT the Archiver container DO, to keep the container's lifecycle
// separate from durable app state). Chosen over KV/D1 because it needs no
// namespace-create step, is strongly consistent (a poll right after a write sees
// it), and reuses infra this Worker already depends on. Two tables:
//   users — one row per signed-in Google account (see the OAuth flow): the acting
//           user's encrypted Drive refresh token and their chosen destination
//           folder. This is the multi-user credential store.
//   jobs  — per-URL conversion status, scoped by `owner` (the user's Google sub).
// Everything lives in one singleton instance (see store()); this low-volume tool
// never outgrows one DO. Job states: queued -> done | dropped (permanent) |
// failed (transient error that exhausted every retry).
export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS users (sub TEXT PRIMARY KEY, email TEXT, refresh_token TEXT, folder_id TEXT, folder_name TEXT, ts INTEGER)"
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, owner TEXT, url TEXT, state TEXT, error TEXT, filename TEXT, ts INTEGER)"
    );
  }

  // Create or update a user on login. refresh_token is preserved when Google
  // omits it on a repeat consent (COALESCE keeps the existing encrypted value),
  // and folder_id/folder_name are never touched here so a re-login can't wipe the
  // user's chosen folder.
  upsertUser({ sub, email, refreshToken }) {
    this.sql.exec(
      `INSERT INTO users (sub, email, refresh_token, folder_id, folder_name, ts)
       VALUES (?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(sub) DO UPDATE SET
         email = excluded.email,
         refresh_token = COALESCE(excluded.refresh_token, users.refresh_token),
         ts = excluded.ts`,
      sub,
      email ?? null,
      refreshToken ?? null,
      Date.now()
    );
  }

  getUser(sub) {
    return this.sql.exec("SELECT * FROM users WHERE sub = ?", sub).toArray()[0] ?? null;
  }

  setFolder(sub, folderId, folderName) {
    this.sql.exec(
      "UPDATE users SET folder_id = ?, folder_name = ? WHERE sub = ?",
      folderId,
      folderName ?? null,
      sub
    );
  }

  put(job) {
    // Self-pruning: drop records older than a week on each write so the table
    // stays tiny without a scheduled job. Cheap at this volume.
    const now = Date.now();
    this.sql.exec("DELETE FROM jobs WHERE ts < ?", now - 7 * 24 * 3600 * 1000);
    this.sql.exec(
      "INSERT OR REPLACE INTO jobs (id, owner, url, state, error, filename, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
      job.id,
      job.owner ?? null,
      job.url ?? null,
      job.state,
      job.error ?? null,
      job.filename ?? null,
      now
    );
  }

  // Scoped by owner: a user only ever sees their own jobs.
  list(owner, limit = 25) {
    return this.sql
      .exec("SELECT * FROM jobs WHERE owner = ? ORDER BY ts DESC LIMIT ?", owner, limit)
      .toArray();
  }
}

// Single shared instance keyed by a fixed name: all rows live together and
// reads/writes serialize through one DO (fine at this volume).
function store(env) {
  return env.STORE.get(env.STORE.idFromName("store"));
}

const COOKIE_NAME = "__Host-rl_session";
const STATE_COOKIE = "__Host-rl_oauth";
const NEXT_COOKIE = "__Host-rl_next";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days; short enough that an
// allowlist removal takes effect reasonably soon (sessions are stateless, so
// there is no per-request revocation — see verifySession).
const STATE_TTL_S = 600; // OAuth round-trip window.

// A queue message is delivered once, then retried up to max_retries times, so the
// last delivery is attempt (max_retries + 1); msg.attempts starts at 1. There is
// no dead-letter queue, so the queue() consumer must record the job "failed" on
// this final attempt before Cloudflare drops the message. MUST equal
// max_retries + 1 for the "read-later" consumer in wrangler.toml: too high and a
// truly-exhausted message is silently lost; too low and jobs fail prematurely.
const MAX_DELIVERY_ATTEMPTS = 4;

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const OAUTH_SCOPES = `openid email profile ${DRIVE_SCOPE}`;

// --- small encoding + crypto helpers (Web Crypto, available in Workers) ---

function b64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlEncodeStr(str) {
  return b64url(new TextEncoder().encode(str));
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlDecodeStr(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}

// Constant-time compare of two strings. The length check leaks length, which is
// fine for these tokens; the loop keeps the comparison time independent of where
// the first differing byte is.
function timingSafeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(env, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

// AES-GCM key for encrypting stored refresh tokens, derived from SESSION_SECRET
// (domain-separated so it never collides with the HMAC use). Rotating
// SESSION_SECRET therefore both logs everyone out AND makes stored tokens
// undecryptable — which is self-healing: the next login re-consents and stores a
// fresh token. DO storage is already encrypted at rest, so this is defense in
// depth against a stray SQL dump.
async function aesKey(env) {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("rl-enc:" + env.SESSION_SECRET)
  );
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}
async function encryptSecret(env, plaintext) {
  const key = await aesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return b64url(iv) + "." + b64url(new Uint8Array(ct));
}
async function decryptSecret(env, blob) {
  const [ivB, ctB] = String(blob).split(".");
  const key = await aesKey(env);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64urlToBytes(ivB) },
    key,
    b64urlToBytes(ctB)
  );
  return new TextDecoder().decode(pt);
}

function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// --- sessions: a stateless, HMAC-signed cookie carrying the user's Google sub ---
// value = b64url(sub).b64url(exp).b64url(HMAC(sub.exp)). No server-side session
// store, so the only per-request cost is recomputing one HMAC. Tamper-proof
// because exp is inside the signed payload. Trade-off: no per-session revocation;
// rotate SESSION_SECRET for a global logout, and keep the TTL modest.
async function makeSessionCookie(env, sub) {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = b64urlEncodeStr(sub) + "." + b64urlEncodeStr(String(exp));
  const value = payload + "." + b64url(await hmac(env, payload));
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000
  )}`;
}

// Returns the authenticated user's Google sub, or null. Fails closed.
async function verifySession(req, env) {
  if (!env.SESSION_SECRET) return null;
  const raw = parseCookie(req.headers.get("cookie"), COOKIE_NAME);
  if (!raw || raw.length > 1024) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [subB, expB, sigB] = parts;
  const expected = b64url(await hmac(env, subB + "." + expB));
  if (!timingSafeEqual(sigB, expected)) return null;
  let exp, sub;
  try {
    exp = Number(b64urlDecodeStr(expB));
    sub = b64urlDecodeStr(subB);
  } catch {
    return null;
  }
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  return sub;
}

function clearCookie(name) {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// --- OAuth helpers ---

// The __Host- prefix forces Secure + Path=/ + no Domain. SameSite=Lax so the
// short-lived state/next cookies survive Google's top-level redirect back to the
// callback (Strict would drop them on that cross-site navigation).
function shortCookie(name, value) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${STATE_TTL_S}`;
}

function buildAuthUrl(env, origin, state) {
  return (
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: `${origin}/auth/callback`,
      response_type: "code",
      scope: OAUTH_SCOPES,
      access_type: "offline",
      prompt: "consent",
      state,
    })
  );
}

// The id_token is a JWT delivered directly from Google's token endpoint over TLS,
// so its payload can be trusted without local signature verification.
function decodeIdToken(idToken) {
  const parts = String(idToken).split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(b64urlDecodeStr(parts[1]));
  } catch {
    return null;
  }
}

function emailAllowed(env, email) {
  const list = (env.ALLOWED_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return !!email && list.includes(String(email).toLowerCase());
}

// Only permit same-origin, absolute-path redirect targets, so a crafted ?next=
// can't bounce the user off-site (`//evil`, `/\evil`, absolute URLs) or split
// headers (control chars) after login.
function safeNext(next) {
  if (typeof next !== "string" || !next || next.length > 512) return "/";
  if (next[0] !== "/" || next[1] === "/" || next[1] === "\\") return "/";
  if (/[\x00-\x1f\x7f]/.test(next)) return "/";
  return next;
}

function redirectToLogin(url) {
  const next = encodeURIComponent(url.pathname + url.search);
  return new Response(null, { status: 302, headers: { location: `/login?next=${next}` } });
}

// Reject anything that isn't a plain http(s) URL to a public host, so an enqueued
// URL can't make the container fetch internal addresses (cloud metadata at
// 169.254.169.254, loopback, RFC1918, link-local). Limitation: a public hostname
// that later resolves to a private IP (DNS rebinding) is not caught — acceptable
// for a low-volume, allowlisted tool.
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

// Assemble the acting user's Drive credentials from stored + env values, or null
// if the user can't upload yet (no refresh token or no chosen folder).
async function userCreds(env, user) {
  if (!user || !user.refresh_token || !user.folder_id) return null;
  let refreshToken;
  try {
    refreshToken = await decryptSecret(env, user.refresh_token);
  } catch {
    return null; // token encrypted under a rotated SESSION_SECRET; re-login fixes it
  }
  return {
    creds: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken,
    },
    folderId: user.folder_id,
  };
}

const JSON_HEADERS = { "content-type": "application/json" };
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    // --- Unauthenticated surfaces: the login page and the OAuth round-trip. ---

    if (path === "/login" && req.method === "GET") {
      return new Response(renderLanding(url.searchParams.get("next")), { headers: HTML_HEADERS });
    }

    // Public legal pages and brand mark. Kept before the session gate so Google's
    // OAuth consent screen and logged-out visitors can reach them.
    if (path === "/privacy" && req.method === "GET") {
      return new Response(renderPrivacy(), { headers: HTML_HEADERS });
    }

    if (path === "/terms" && req.method === "GET") {
      return new Response(renderTerms(), { headers: HTML_HEADERS });
    }

    if (path === "/favicon.svg" && req.method === "GET") {
      return new Response(LOGO_SVG, {
        headers: {
          "content-type": "image/svg+xml",
          "cache-control": "public, max-age=86400, immutable",
        },
      });
    }

    // Browsers still probe /favicon.ico; answer empty so it doesn't bounce to
    // /login. The real icon is declared via <link rel="icon"> to /favicon.svg.
    if (path === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    if (path === "/logout") {
      return new Response(null, {
        status: 302,
        headers: { location: "/login", "set-cookie": clearCookie(COOKIE_NAME) },
      });
    }

    if (path === "/auth/login" && req.method === "GET") {
      if (!env.GOOGLE_CLIENT_ID || !env.SESSION_SECRET) {
        return new Response("Server misconfigured: GOOGLE_CLIENT_ID/SESSION_SECRET unset.", {
          status: 500,
        });
      }
      const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
      const headers = new Headers({ location: buildAuthUrl(env, url.origin, state) });
      headers.append("set-cookie", shortCookie(STATE_COOKIE, state));
      const next = safeNext(url.searchParams.get("next"));
      if (next !== "/") headers.append("set-cookie", shortCookie(NEXT_COOKIE, b64urlEncodeStr(next)));
      return new Response(null, { status: 302, headers });
    }

    if (path === "/auth/callback" && req.method === "GET") {
      const cookie = req.headers.get("cookie");
      const expectedState = parseCookie(cookie, STATE_COOKIE);
      const gotState = url.searchParams.get("state");
      if (!expectedState || !gotState || !timingSafeEqual(gotState, expectedState)) {
        return new Response("Invalid OAuth state. Try logging in again.", { status: 400 });
      }
      const code = url.searchParams.get("code");
      if (!code) return new Response("Missing code.", { status: 400 });

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${url.origin}/auth/callback`,
          grant_type: "authorization_code",
        }),
      });
      if (!tokenRes.ok) {
        return new Response(`Token exchange failed: ${tokenRes.status}`, { status: 502 });
      }
      const tokens = await tokenRes.json();
      const claims = decodeIdToken(tokens.id_token);
      if (!claims || !claims.email || claims.email_verified === false) {
        return new Response("Could not read a verified email from Google.", { status: 400 });
      }
      if (!emailAllowed(env, claims.email)) {
        return new Response(
          `${claims.email} is not on the allowlist for this app.`,
          { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } }
        );
      }

      const refreshToken = tokens.refresh_token
        ? await encryptSecret(env, tokens.refresh_token)
        : undefined; // omitted on repeat consent; upsert keeps the existing one
      await store(env).upsertUser({ sub: claims.sub, email: claims.email, refreshToken });

      const next = safeNext(
        parseCookie(cookie, NEXT_COOKIE) ? b64urlDecodeStr(parseCookie(cookie, NEXT_COOKIE)) : "/"
      );
      const headers = new Headers({ location: next });
      headers.append("set-cookie", await makeSessionCookie(env, claims.sub));
      headers.append("set-cookie", clearCookie(STATE_COOKIE));
      headers.append("set-cookie", clearCookie(NEXT_COOKIE));
      return new Response(null, { status: 302, headers });
    }

    // --- Everything below requires a valid session. API endpoints answer 401 so
    // the dashboard's fetches can turn that into a login redirect; page
    // navigations bounce to /login carrying where they were headed. ---
    const userId = await verifySession(req, env);
    if (!userId) {
      if (path === "/jobs" || path === "/enqueue" || path === "/folder") {
        return json({ error: "unauthorized" }, 401);
      }
      // Serve the home page itself (not a redirect) at "/" so Google's OAuth
      // branding verifier finds a real page stating the app's purpose at the
      // exact home-page URL. Carry any ?url= (from the bookmarklet) through login
      // so a logged-out save still lands back on a pre-filled dashboard.
      if (req.method === "GET" && path === "/") {
        const next = url.search ? "/" + url.search : "";
        return new Response(renderLanding(next), { headers: HTML_HEADERS });
      }
      return redirectToLogin(url);
    }

    if (req.method === "GET" && path === "/") {
      const user = await store(env).getUser(userId);
      return new Response(
        renderUI({
          origin: url.origin,
          clientId: env.GOOGLE_CLIENT_ID,
          apiKey: env.GOOGLE_API_KEY,
          appId: env.GOOGLE_PROJECT_NUMBER,
          folderName: user?.folder_name || null,
        }),
        { headers: HTML_HEADERS }
      );
    }

    // Store a folder the user picked in the Drive Picker. Verify the backend
    // refresh token can actually see it (the drive.file grant must have
    // propagated to this OAuth client) before trusting it, and capture its name.
    if (req.method === "POST" && path === "/folder") {
      let folderId;
      try {
        folderId = (await req.json()).folderId;
      } catch {
        folderId = undefined;
      }
      if (typeof folderId !== "string" || !folderId || folderId.length > 256) {
        return json({ error: "invalid folder" }, 400);
      }
      const user = await store(env).getUser(userId);
      if (!user || !user.refresh_token) return json({ error: "no drive credentials" }, 400);
      let refreshToken;
      try {
        refreshToken = await decryptSecret(env, user.refresh_token);
      } catch {
        return json({ error: "credentials expired, please sign in again" }, 400);
      }
      let file;
      try {
        file = await getDriveFile(
          { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, refreshToken },
          folderId
        );
      } catch (err) {
        console.error(`folder verify failed for ${userId}: ${err}`);
        return json({ error: "could not access that folder" }, 400);
      }
      await store(env).setFolder(userId, file.id, file.name);
      return json({ ok: true, name: file.name });
    }

    if (req.method === "POST" && path === "/enqueue") {
      let target;
      try {
        target = (await req.json()).url;
      } catch {
        target = undefined;
      }
      if (!isAllowedTarget(target)) return json({ error: "invalid url" }, 400);
      const user = await store(env).getUser(userId);
      if (!user || !user.folder_id) return json({ error: "no folder" }, 400);

      const jobId = crypto.randomUUID();
      await store(env).put({ id: jobId, owner: userId, url: target, state: "queued" });
      await env.QUEUE.send({ url: target, jobId, userId });
      return json({ ok: true, jobId });
    }

    if (req.method === "GET" && path === "/jobs") {
      const jobs = await store(env).list(userId);
      return json(jobs);
    }

    return new Response("Not found", { status: 404 });
  },

  async queue(batch, env) {
    for (const msg of batch.messages) {
      const { url, jobId, userId } = msg.body;
      try {
        // Resolve the acting user's Drive credentials up front. A missing folder
        // or credentials is permanent (the user must pick a folder / re-login),
        // so drop rather than retry.
        const user = await store(env).getUser(userId);
        const resolved = await userCreds(env, user);
        if (!resolved) {
          console.error(`dropping ${url}: no drive folder/credentials for ${userId}`);
          await store(env).put({
            id: jobId,
            owner: userId,
            url,
            state: "dropped",
            error: "no Drive folder chosen (or sign-in expired)",
          });
          msg.ack();
          continue;
        }

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
            await store(env).put({ id: jobId, owner: userId, url, state: "dropped", error: detail });
            msg.ack();
            continue;
          }
          throw new Error(`convert failed: ${detail}`);
        }

        const filename = safeName(decodeURIComponent(resp.headers.get("x-filename") || "article.epub"));
        const bytes = new Uint8Array(await resp.arrayBuffer());
        const result = await uploadToDrive(resolved.creds, resolved.folderId, filename, bytes);
        console.log(`uploaded ${filename} (${bytes.length} bytes) as ${result.id}`);
        await store(env).put({ id: jobId, owner: userId, url, state: "done", filename });
        msg.ack();
      } catch (err) {
        // No DLQ: on the final delivery, record the real error as "failed" and
        // ack so Cloudflare doesn't silently drop the message. Earlier attempts
        // retry with no status write, so the record stays "queued" and the UI
        // keeps showing "working". The attempt number is logged so an off-by-one
        // in MAX_DELIVERY_ATTEMPTS is observable in `wrangler tail`.
        console.error(`failed ${url} (attempt ${msg.attempts}): ${err.stack || err}`);
        if (msg.attempts >= MAX_DELIVERY_ATTEMPTS) {
          await store(env).put({
            id: jobId,
            owner: userId,
            url,
            state: "failed",
            error: String(err.message || err).slice(0, 500),
          });
          msg.ack();
        } else {
          msg.retry();
        }
      }
    }
  },
};
