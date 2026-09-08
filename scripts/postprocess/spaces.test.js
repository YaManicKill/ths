const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {
  buildSigV4Headers,
  encodeS3Key,
  resolveSpaces,
  setObjectAcl,
  uploadFileToSpaces,
} = require("./spaces");

// A loopback server stands in for Spaces: it captures the PUT verbatim, and the test
// re-derives the signature from what actually arrived - so a mismatch between what is
// sent and what was signed (wrong host, path, or payload hash) fails here rather than
// as a live 403.
async function main() {
  assert.equal(
    encodeS3Key("ths/year3/winter/ths 12-10.mp3"),
    "ths/year3/winter/ths%2012-10.mp3",
  );

  assert.equal(resolveSpaces({ spaces: { bucket: "b", region: "r" } }), null);
  assert.deepEqual(
    resolveSpaces({
      spaces: {
        bucket: "ymk",
        region: "nyc3",
        accessKeyId: "AK",
        secretAccessKey: "SK",
      },
    }),
    { bucket: "ymk", region: "nyc3", accessKeyId: "AK", secretAccessKey: "SK" },
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ths-spaces-"));
  const filePath = path.join(dir, "episode.mp3");
  const payload = crypto.randomBytes(256 * 1024);
  fs.writeFileSync(filePath, payload);

  let received = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      res.statusCode = 200;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const progress = [];
  const result = await uploadFileToSpaces({
    filePath,
    key: "ths/year3/winter/ths-12-10.mp3",
    bucket: "ymk",
    region: "nyc3",
    accessKeyId: "TESTKEY",
    secretAccessKey: "TESTSECRET",
    contentType: "audio/mpeg",
    baseUrl,
    onProgress: (event) => progress.push(event.percent),
  });

  assert.equal(received.method, "PUT");
  assert.equal(received.url, "/ths/year3/winter/ths-12-10.mp3");
  assert.equal(
    received.headers["x-amz-acl"],
    "private",
    "uploads must stage privately by default",
  );
  assert.equal(received.headers["content-type"], "audio/mpeg");
  assert.equal(Number(received.headers["content-length"]), payload.length);
  assert.ok(received.body.equals(payload), "uploaded bytes were corrupted");

  const bodyHash = crypto
    .createHash("sha256")
    .update(received.body)
    .digest("hex");
  assert.equal(
    received.headers["x-amz-content-sha256"],
    bodyHash,
    "signed payload hash must match the bytes on the wire",
  );

  // Re-derive the signature from the received request with the shared secret, the way
  // the real service verifies it.
  const rederived = buildSigV4Headers({
    method: "PUT",
    host: received.headers.host,
    pathName: received.url,
    headers: {
      "content-type": received.headers["content-type"],
      "x-amz-acl": received.headers["x-amz-acl"],
    },
    payloadHash: bodyHash,
    region: "nyc3",
    accessKeyId: "TESTKEY",
    secretAccessKey: "TESTSECRET",
    now: new Date(
      received.headers["x-amz-date"].replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
        "$1-$2-$3T$4:$5:$6Z",
      ),
    ),
  });
  assert.equal(
    received.headers.authorization,
    rederived.authorization,
    "signature does not verify against the received request",
  );

  // Going public is an ACL rewrite on the ?acl subresource, signed with the query in
  // the canonical request and an empty payload.
  await setObjectAcl({
    key: "ths/year3/winter/ths-12-10.mp3",
    bucket: "ymk",
    region: "nyc3",
    accessKeyId: "TESTKEY",
    secretAccessKey: "TESTSECRET",
    acl: "public-read",
    baseUrl,
  });
  assert.equal(received.method, "PUT");
  assert.equal(received.url, "/ths/year3/winter/ths-12-10.mp3?acl=");
  assert.equal(received.headers["x-amz-acl"], "public-read");
  assert.equal(received.body.length, 0);
  const aclRederived = buildSigV4Headers({
    method: "PUT",
    host: received.headers.host,
    pathName: "/ths/year3/winter/ths-12-10.mp3",
    query: "acl=",
    headers: { "x-amz-acl": "public-read" },
    payloadHash: crypto.createHash("sha256").update("").digest("hex"),
    region: "nyc3",
    accessKeyId: "TESTKEY",
    secretAccessKey: "TESTSECRET",
    now: new Date(
      received.headers["x-amz-date"].replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
        "$1-$2-$3T$4:$5:$6Z",
      ),
    ),
  });
  assert.equal(
    received.headers.authorization,
    aclRederived.authorization,
    "ACL signature does not verify against the received request",
  );

  assert.equal(progress[progress.length - 1], 100);
  assert.equal(result.size, payload.length);
  assert.equal(result.sha256, bodyHash);
  assert.equal(
    result.url,
    "https://ymk.nyc3.digitaloceanspaces.com/ths/year3/winter/ths-12-10.mp3",
  );

  // A non-2xx response surfaces the service's message instead of resolving.
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    req.resume();
    req.on("end", () => {
      res.statusCode = 403;
      res.end("SignatureDoesNotMatch");
    });
  });
  await assert.rejects(
    uploadFileToSpaces({
      filePath,
      key: "k.mp3",
      bucket: "ymk",
      region: "nyc3",
      accessKeyId: "TESTKEY",
      secretAccessKey: "TESTSECRET",
      baseUrl,
    }),
    /403.*SignatureDoesNotMatch/s,
  );

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("spaces test passed");
}

main().catch((error) => {
  console.error("spaces test failed:", error.message);
  process.exit(1);
});
