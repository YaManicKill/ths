const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");

// DigitalOcean Spaces speaks the S3 protocol, and a single signed PUT covers files up
// to 5GB - far past any episode - so the upload needs no SDK, just AWS SigV4 signing
// over node's own crypto and https.

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256FileHex(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

// S3 wants each path segment URI-encoded but the slashes kept.
function encodeS3Key(key) {
  return String(key)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

// Standard SigV4: canonical request -> string to sign -> derived signing key. Returns
// every header to send, authorization included. Headers passed in must already have
// lowercase names.
function buildSigV4Headers({
  method,
  host,
  pathName,
  // Already-canonical query string ("acl=" for the ACL subresource); empty for a
  // plain object PUT.
  query = "",
  headers = {},
  payloadHash,
  region,
  accessKeyId,
  secretAccessKey,
  now = new Date(),
}) {
  const amzDate = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const allHeaders = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...headers,
  };
  const signedNames = Object.keys(allHeaders).sort();
  const canonicalHeaders = signedNames
    .map((name) => `${name}:${String(allHeaders[name]).trim()}\n`)
    .join("");
  const signedHeaders = signedNames.join(";");

  const canonicalRequest = [
    method,
    pathName,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), "s3"),
    "aws4_request",
  );
  const signature = crypto
    .createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  return {
    ...allHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// Streams one local file into the bucket as a public object. baseUrl exists for tests
// (a loopback server standing in for Spaces); real uploads derive the endpoint from
// bucket and region.
async function uploadFileToSpaces({
  filePath,
  key,
  bucket,
  region,
  accessKeyId,
  secretAccessKey,
  contentType = "application/octet-stream",
  // Private by default: the episode goes up ahead of time and is flipped public just
  // before release via setObjectAcl.
  acl = "private",
  payloadSha256,
  baseUrl,
  onProgress = () => {},
}) {
  const stat = fs.statSync(filePath);
  const payloadHash = payloadSha256 || (await sha256FileHex(filePath));
  const url = new URL(
    baseUrl || `https://${bucket}.${region}.digitaloceanspaces.com`,
  );
  const pathName = `/${encodeS3Key(key)}`;

  const headers = buildSigV4Headers({
    method: "PUT",
    host: url.host,
    pathName,
    headers: {
      "content-type": contentType,
      "x-amz-acl": acl,
    },
    payloadHash,
    region,
    accessKeyId,
    secretAccessKey,
  });

  await new Promise((resolve, reject) => {
    const lib = url.protocol === "http:" ? http : https;
    const request = lib.request(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        method: "PUT",
        path: pathName,
        // content-length rides unsigned; only the signed set is in the canonical
        // request.
        headers: { ...headers, "content-length": stat.size },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve();
          } else {
            reject(
              new Error(
                `Spaces upload failed (${response.statusCode}): ${body.slice(0, 300)}`,
              ),
            );
          }
        });
      },
    );
    request.on("error", reject);

    let sentBytes = 0;
    const fileStream = fs.createReadStream(filePath);
    fileStream.on("data", (chunk) => {
      sentBytes += chunk.length;
      onProgress({
        sentBytes,
        totalBytes: stat.size,
        percent: Math.round((sentBytes / stat.size) * 100),
      });
    });
    fileStream.on("error", (error) => {
      request.destroy(error);
      reject(error);
    });
    fileStream.pipe(request);
  });

  return {
    url: `https://${bucket}.${region}.digitaloceanspaces.com/${encodeS3Key(key)}`,
    size: stat.size,
    sha256: payloadHash,
  };
}

// Rewrites one object's ACL via the ?acl subresource - how a privately-staged episode
// goes public at release time without re-uploading a byte.
function setObjectAcl({
  key,
  bucket,
  region,
  accessKeyId,
  secretAccessKey,
  acl,
  baseUrl,
}) {
  const url = new URL(
    baseUrl || `https://${bucket}.${region}.digitaloceanspaces.com`,
  );
  const pathName = `/${encodeS3Key(key)}`;
  const emptyPayloadHash = sha256Hex("");

  const headers = buildSigV4Headers({
    method: "PUT",
    host: url.host,
    pathName,
    query: "acl=",
    headers: { "x-amz-acl": acl },
    payloadHash: emptyPayloadHash,
    region,
    accessKeyId,
    secretAccessKey,
  });

  return new Promise((resolve, reject) => {
    const lib = url.protocol === "http:" ? http : https;
    const request = lib.request(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        method: "PUT",
        path: `${pathName}?acl=`,
        headers: { ...headers, "content-length": 0 },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve();
          } else {
            reject(
              new Error(
                `Spaces ACL update failed (${response.statusCode}): ${body.slice(0, 300)}`,
              ),
            );
          }
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

// Credentials come from the gitignored local config (or the environment); without
// them the upload feature simply is not available.
function resolveSpaces(config) {
  const spaces = config?.spaces || {};
  const accessKeyId = spaces.accessKeyId || process.env.DO_SPACES_KEY || null;
  const secretAccessKey =
    spaces.secretAccessKey || process.env.DO_SPACES_SECRET || null;
  if (!accessKeyId || !secretAccessKey || !spaces.bucket || !spaces.region) {
    return null;
  }
  return {
    bucket: spaces.bucket,
    region: spaces.region,
    accessKeyId,
    secretAccessKey,
  };
}

module.exports = {
  buildSigV4Headers,
  encodeS3Key,
  resolveSpaces,
  setObjectAcl,
  sha256FileHex,
  uploadFileToSpaces,
};
