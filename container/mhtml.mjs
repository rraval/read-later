// Parser for Chrome "Save Page As → Webpage, Single File" captures: MHTML
// (RFC 2557 multipart/related). Dependency-free, pure functions, no I/O, so it
// unit-tests with `node --test` on the host; convert-mhtml.mjs does the I/O.
//
// The buffer is handled as a latin1 string: that mapping is byte-preserving,
// the multipart framing and transfer encodings are all ASCII, and each part's
// real bytes are recovered per its Content-Transfer-Encoding before any
// charset decoding happens.

// Join header continuation lines (RFC 822 folding) before parsing.
function unfold(block) {
  return block.replace(/\r?\n[ \t]+/g, " ");
}

function parseHeaders(block) {
  const headers = {};
  for (const line of unfold(block).split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

// Extract a parameter (boundary, charset, start) from a structured header
// value; tolerates both quoted and bare forms.
function headerParam(value, name) {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]+)"|[^\\s;]+)`, "i").exec(value || "");
  if (!m) return null;
  return (m[2] ?? m[1]).trim();
}

// Split a raw part at its header/body boundary, tolerating bare-LF files.
function splitHeadersBody(chunk) {
  const crlf = chunk.indexOf("\r\n\r\n");
  const lf = chunk.indexOf("\n\n");
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    return [chunk.slice(0, crlf), chunk.slice(crlf + 4)];
  }
  if (lf !== -1) return [chunk.slice(0, lf), chunk.slice(lf + 2)];
  return [chunk, ""];
}

// Quoted-printable to bytes: =XX escapes, soft line breaks (=<CRLF>) removed.
export function decodeQuotedPrintable(text) {
  const out = new Uint8Array(text.length);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "=") {
      if (text[i + 1] === "\r" && text[i + 2] === "\n") {
        i += 2;
        continue;
      }
      if (text[i + 1] === "\n") {
        i += 1;
        continue;
      }
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out[n++] = parseInt(hex, 16);
        i += 2;
        continue;
      }
    }
    out[n++] = text.charCodeAt(i) & 0xff;
  }
  return out.subarray(0, n);
}

function decodeBody(bodyText, encoding) {
  switch ((encoding || "").toLowerCase()) {
    case "base64":
      return Buffer.from(bodyText, "base64"); // whitespace is skipped
    case "quoted-printable":
      return Buffer.from(decodeQuotedPrintable(bodyText));
    default: // 7bit / 8bit / binary
      return Buffer.from(bodyText, "latin1");
  }
}

// Parse an MHTML buffer into the root HTML document plus its image parts.
// Returns { rootHtml, rootLocation, assets: [{ location, mime, bytes }] }.
// Throws on anything that isn't a multipart/related capture with an HTML part.
export function parseMhtml(input) {
  const text = input.toString("latin1");
  const [topBlock, rest] = splitHeadersBody(text);
  const top = parseHeaders(topBlock);
  const contentType = top["content-type"] || "";
  if (!/multipart\/related/i.test(contentType)) {
    throw new Error("not an MHTML file (expected a multipart/related Content-Type)");
  }
  const boundary = headerParam(contentType, "boundary");
  if (!boundary) throw new Error("MHTML is missing its multipart boundary");

  const parts = [];
  for (let chunk of rest.split("--" + boundary).slice(1)) {
    if (chunk.startsWith("--")) break; // closing delimiter
    chunk = chunk.replace(/^\r?\n/, "");
    const [headerBlock, body] = splitHeadersBody(chunk);
    parts.push({
      headers: parseHeaders(headerBlock),
      body: body.replace(/\r?\n$/, ""), // CRLF belonging to the next delimiter
    });
  }

  // Root document: the part named by the start= parameter if present,
  // otherwise the first text/html part (Chrome puts it first).
  const isHtml = (p) => /^text\/html\b/i.test(p.headers["content-type"] || "");
  const startId = headerParam(contentType, "start");
  let root = null;
  if (startId) {
    const id = startId.replace(/[<>]/g, "");
    root = parts.find((p) => (p.headers["content-id"] || "").includes(id)) ?? null;
  }
  if (!root || !isHtml(root)) root = parts.find(isHtml) ?? null;
  if (!root) throw new Error("MHTML contains no text/html part");

  const rootBytes = decodeBody(root.body, root.headers["content-transfer-encoding"]);
  const charset = headerParam(root.headers["content-type"], "charset") || "utf-8";
  let rootHtml;
  try {
    rootHtml = new TextDecoder(charset).decode(rootBytes);
  } catch {
    rootHtml = new TextDecoder().decode(rootBytes); // unknown label: assume UTF-8
  }
  const rootLocation =
    root.headers["content-location"] || top["snapshot-content-location"] || null;

  // Only images are extracted: percollate applies its own stylesheet and
  // Readability strips scripts/frames, so CSS/JS/font/media parts are dead
  // weight for an EPUB.
  const assets = [];
  for (const p of parts) {
    if (p === root) continue;
    const mime = (p.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const location = p.headers["content-location"];
    if (!location || !mime.startsWith("image/")) continue;
    assets.push({
      location,
      mime,
      bytes: decodeBody(p.body, p.headers["content-transfer-encoding"]),
    });
  }

  return { rootHtml, rootLocation, assets };
}

// Replace each asset's original URL with its serving URL, in both the raw form
// and the &amp;-escaped form Chrome writes inside attribute values (this also
// covers srcset, which uses the same absolute URLs). Longest URL first, so a
// URL that extends another (…/img.png vs …/img.png?large) isn't clobbered by
// its prefix's replacement.
export function rewriteReferences(html, replacements) {
  const byLength = [...replacements].sort((a, b) => b.from.length - a.from.length);
  for (const { from, to } of byLength) {
    html = html.split(from).join(to);
    const escaped = from.replaceAll("&", "&amp;");
    if (escaped !== from) html = html.split(escaped).join(to);
  }
  return html;
}

// Extensions for the served asset names. percollate derives the EPUB manifest
// mimetype from the URL path's extension, so these must be real; ".image" is
// percollate's own generic-image fallback for anything it can't classify.
const MIME_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/tiff": ".tif",
};

export function extensionForMime(mime) {
  return MIME_EXT[mime] || ".image";
}
