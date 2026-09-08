const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {
  buildAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  renderTitleTemplate,
  resolveYoutube,
  uploadVideoToYoutube,
} = require("./youtube");

async function main() {
  assert.equal(resolveYoutube({ youtube: { clientId: "id" } }), null);
  assert.equal(
    resolveYoutube({
      youtube: { clientId: "id", clientSecret: "secret" },
    }).titleTemplate,
    "{mainTopic} Review",
  );

  assert.equal(
    renderTitleTemplate("{mainTopic} Review", { mainTopic: "Pokopia" }),
    "Pokopia Review",
  );
  assert.equal(
    renderTitleTemplate("THS {code}: {title}", {
      code: "12-10",
      title: "Bubble Those Watermelons",
    }),
    "THS 12-10: Bubble Those Watermelons",
  );

  const authUrl = new URL(
    buildAuthUrl({
      clientId: "client-1",
      redirectUri: "http://127.0.0.1:4173/api/youtube-oauth-callback",
    }),
  );
  assert.equal(authUrl.searchParams.get("client_id"), "client-1");
  assert.equal(
    authUrl.searchParams.get("scope"),
    "https://www.googleapis.com/auth/youtube.upload",
  );
  assert.equal(authUrl.searchParams.get("access_type"), "offline");
  assert.equal(authUrl.searchParams.get("prompt"), "consent");

  // A loopback server plays Google: the token endpoint asserts the exact form fields,
  // the upload endpoint asserts the resumable protocol - metadata POST answered with
  // an upload URL, then the streamed PUT of the actual bytes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ths-youtube-"));
  const filePath = path.join(dir, "episode.mp4");
  const payload = crypto.randomBytes(128 * 1024);
  fs.writeFileSync(filePath, payload);

  let tokenForm = null;
  let initRequest = null;
  let putRequest = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (req.url === "/token") {
        tokenForm = Object.fromEntries(new URLSearchParams(body.toString()));
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ access_token: "at-123", refresh_token: "rt-456" }),
        );
        return;
      }
      if (req.url.startsWith("/upload")) {
        initRequest = {
          headers: req.headers,
          body: JSON.parse(body.toString()),
        };
        res.statusCode = 200;
        res.setHeader(
          "location",
          `http://127.0.0.1:${server.address().port}/put-target?upload_id=u1`,
        );
        res.end();
        return;
      }
      if (req.url.startsWith("/put-target")) {
        putRequest = { headers: req.headers, body };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "vid-789" }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const exchanged = await exchangeCodeForToken({
    clientId: "client-1",
    clientSecret: "secret-1",
    code: "code-abc",
    redirectUri: "http://127.0.0.1:4173/api/youtube-oauth-callback",
    tokenEndpoint: `${base}/token`,
  });
  assert.equal(exchanged.refresh_token, "rt-456");
  assert.equal(tokenForm.grant_type, "authorization_code");
  assert.equal(tokenForm.code, "code-abc");
  assert.equal(tokenForm.client_secret, "secret-1");

  const refreshed = await refreshAccessToken({
    clientId: "client-1",
    clientSecret: "secret-1",
    refreshToken: "rt-456",
    tokenEndpoint: `${base}/token`,
  });
  assert.equal(refreshed.access_token, "at-123");
  assert.equal(tokenForm.grant_type, "refresh_token");
  assert.equal(tokenForm.refresh_token, "rt-456");

  const progress = [];
  const uploaded = await uploadVideoToYoutube({
    filePath,
    accessToken: "at-123",
    snippet: {
      title: "Pokopia Review",
      description: "Notes",
      categoryId: "20",
      tags: ["podcast"],
    },
    status: {
      privacyStatus: "private",
      publishAt: "2026-09-09T18:00:00Z",
      selfDeclaredMadeForKids: false,
    },
    uploadEndpoint: `${base}/upload`,
    onProgress: (event) => progress.push(event.percent),
  });

  assert.equal(uploaded.videoId, "vid-789");
  assert.equal(uploaded.url, "https://www.youtube.com/watch?v=vid-789");
  assert.equal(initRequest.headers.authorization, "Bearer at-123");
  assert.equal(
    Number(initRequest.headers["x-upload-content-length"]),
    payload.length,
  );
  assert.equal(initRequest.body.snippet.title, "Pokopia Review");
  assert.equal(initRequest.body.snippet.categoryId, "20");
  assert.equal(initRequest.body.status.privacyStatus, "private");
  assert.equal(initRequest.body.status.publishAt, "2026-09-09T18:00:00Z");
  assert.equal(putRequest.headers.authorization, "Bearer at-123");
  assert.equal(putRequest.headers["content-type"], "video/mp4");
  assert.ok(putRequest.body.equals(payload), "uploaded bytes were corrupted");
  assert.equal(progress[progress.length - 1], 100);

  // Upload failures surface YouTube's message rather than resolving.
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    req.resume();
    req.on("end", () => {
      res.statusCode = 403;
      res.end("quotaExceeded");
    });
  });
  await assert.rejects(
    uploadVideoToYoutube({
      filePath,
      accessToken: "at-123",
      snippet: {},
      status: {},
      uploadEndpoint: `${base}/upload`,
    }),
    /403.*quotaExceeded/s,
  );

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("youtube test passed");
}

main().catch((error) => {
  console.error("youtube test failed:", error.message);
  process.exit(1);
});
