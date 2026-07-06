// Google Drive access via the REST API. Auth is a per-user refresh token
// (stored, encrypted, in the STORE Durable Object) exchanged for a short-lived
// access token on each call. Nothing but fetch(), so it runs on any plan.
//
// `creds` throughout is { clientId, clientSecret, refreshToken } — the shared
// OAuth client plus the acting user's refresh token.

async function accessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

// Confirm the acting user's refresh token can actually see a folder, and return
// its name. Used right after a Picker selection so we only store a folder_id the
// backend can really write to (the drive.file grant must have propagated to this
// OAuth client). supportsAllDrives lets a folder inside a Shared Drive resolve.
export async function getDriveFile(creds, fileId) {
  const token = await accessToken(creds);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType&supportsAllDrives=true`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`drive get failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function uploadToDrive(creds, folderId, name, bytes) {
  const token = await accessToken(creds);
  const metadata = { name, parents: [folderId] };
  // Random per-upload boundary so it can't collide with a byte sequence that
  // happens to appear inside the EPUB and corrupt the multipart body.
  const boundary = "boundary-" + crypto.randomUUID();

  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\nContent-Type: application/epub+zip\r\n\r\n`,
    bytes,
    `\r\n--${boundary}--`,
  ]);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!res.ok) throw new Error(`drive upload failed: ${res.status} ${await res.text()}`);
  return res.json();
}
