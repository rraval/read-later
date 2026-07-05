// Upload bytes to Google Drive via the REST API. Auth is a one-time refresh
// token exchanged for a short-lived access token on each run (see
// scripts/get-refresh-token.mjs). Nothing but fetch(), so it runs on any plan.

async function accessToken(env) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

export async function uploadToDrive(env, name, bytes) {
  const token = await accessToken(env);
  const metadata = { name, parents: [env.DRIVE_FOLDER_ID] };
  const boundary = "supernote-read-later-boundary";

  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\nContent-Type: application/epub+zip\r\n\r\n`,
    bytes,
    `\r\n--${boundary}--`,
  ]);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name",
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
