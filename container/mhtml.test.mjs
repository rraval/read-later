// Unit tests for mhtml.mjs. Run on the host (no Docker needed):
//   node --test container/
//
// The fixture is assembled here with explicit \r\n instead of being checked in
// as a file, because git/editor newline normalization would silently corrupt
// MHTML's CRLF-based multipart framing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeQuotedPrintable,
  extensionForMime,
  parseMhtml,
  rewriteReferences,
} from "./mhtml.mjs";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const BOUNDARY = "----MultipartBoundary--abc123----";

// Mirrors Chrome's output: folded top headers, quoted-printable UTF-8 HTML
// with a soft line break, base64 image parts (one wrapped across lines), a CSS
// part that must be ignored, and &amp;-escaped URLs inside attributes.
function fixture({ quotedBoundary = true } = {}) {
  const b = quotedBoundary ? `"${BOUNDARY}"` : BOUNDARY;
  return [
    "From: <Saved by Blink>",
    "Snapshot-Content-Location: https://example.com/article",
    "Subject: An Article",
    "MIME-Version: 1.0",
    "Content-Type: multipart/related;",
    '\ttype="text/html";',
    `\tboundary=${b}`,
    "",
    `--${BOUNDARY}`,
    "Content-Type: text/html",
    "Content-ID: <frame-0@mhtml.blink>",
    "Content-Transfer-Encoding: quoted-printable",
    "Content-Location: https://example.com/article",
    "",
    "<html><head><meta charset=3D\"utf-8\"></head><body>caf=C3=A9 =",
    "continued",
    '<img src=3D"https://example.com/a.png">',
    '<img src=3D"https://example.com/a.png?size=3Dlarge&amp;v=3D2">',
    '<img src=3D"https://example.com/photo">',
    "</body></html>",
    `--${BOUNDARY}`,
    "Content-Type: text/css",
    "Content-Transfer-Encoding: quoted-printable",
    "Content-Location: https://example.com/style.css",
    "",
    "body { color: red; }",
    `--${BOUNDARY}`,
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-Location: https://example.com/a.png",
    "",
    PNG_B64,
    `--${BOUNDARY}`,
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-Location: https://example.com/a.png?size=large&v=2",
    "",
    PNG_B64.slice(0, 40),
    PNG_B64.slice(40),
    `--${BOUNDARY}`,
    "Content-Type: image/webp",
    "Content-Transfer-Encoding: base64",
    "Content-Location: https://example.com/photo",
    "",
    PNG_B64,
    `--${BOUNDARY}--`,
    "",
  ].join("\r\n");
}

test("parseMhtml extracts the root document and its location", () => {
  const { rootHtml, rootLocation } = parseMhtml(Buffer.from(fixture(), "latin1"));
  assert.equal(rootLocation, "https://example.com/article");
  // =C3=A9 decoded as UTF-8, soft line break removed, =3D decoded to "="
  assert.match(rootHtml, /café continued/);
  assert.match(rootHtml, /<meta charset="utf-8">/);
});

test("parseMhtml decodes base64 assets and skips non-image parts", () => {
  const { assets } = parseMhtml(Buffer.from(fixture(), "latin1"));
  assert.deepEqual(
    assets.map((a) => a.location),
    [
      "https://example.com/a.png",
      "https://example.com/a.png?size=large&v=2",
      "https://example.com/photo",
    ]
  );
  const expected = Buffer.from(PNG_B64, "base64");
  for (const asset of assets) assert.deepEqual(asset.bytes, expected);
  assert.equal(assets[0].mime, "image/png");
  assert.equal(assets[2].mime, "image/webp");
});

test("parseMhtml handles an unquoted boundary parameter", () => {
  const { assets } = parseMhtml(Buffer.from(fixture({ quotedBoundary: false }), "latin1"));
  assert.equal(assets.length, 3);
});

test("parseMhtml rejects non-MHTML input", () => {
  assert.throws(() => parseMhtml(Buffer.from("<html>not mhtml</html>")), /multipart\/related/);
  assert.throws(
    () => parseMhtml(Buffer.from("Content-Type: multipart/related; boundary=x\r\n\r\n--x--\r\n")),
    /no text\/html part/
  );
});

test("decodeQuotedPrintable handles escapes, soft breaks, and literals", () => {
  const bytes = decodeQuotedPrintable("a=3Db=\r\nc=\nd =zz");
  assert.equal(Buffer.from(bytes).toString("latin1"), "a=bcd =zz");
});

test("rewriteReferences replaces raw and &amp;-escaped URLs, longest first", () => {
  const { rootHtml, assets } = parseMhtml(Buffer.from(fixture(), "latin1"));
  const html = rewriteReferences(
    rootHtml,
    assets.map((a, i) => ({ from: a.location, to: `http://127.0.0.1:9999/${i}.png` }))
  );
  // The querystring URL (written with &amp; in the attribute) got its own
  // replacement instead of being clobbered by its shorter prefix.
  assert.match(html, /src="http:\/\/127\.0\.0\.1:9999\/1\.png"/);
  assert.match(html, /src="http:\/\/127\.0\.0\.1:9999\/0\.png"/);
  assert.match(html, /src="http:\/\/127\.0\.0\.1:9999\/2\.png"/);
  assert.doesNotMatch(html, /example\.com\/(a\.png|photo)/);
});

test("extensionForMime maps known types and falls back generically", () => {
  assert.equal(extensionForMime("image/png"), ".png");
  assert.equal(extensionForMime("image/svg+xml"), ".svg");
  assert.equal(extensionForMime("image/x-exotic"), ".image");
});
