const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("./server");

const PORT = 41994;
const lockPath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "ths-server-lock-")),
  "server.lock",
);
const server = startServer({ port: PORT, lockPath });

function once(event) {
  return new Promise((resolve, reject) => {
    server.once(event, resolve);
    server.once("error", reject);
  });
}

async function main() {
  if (!server.listening) {
    await once("listening");
  }

  // This server reads local files and runs the pipeline with no auth, so it must only be
  // reachable over loopback.
  assert.equal(
    server.address().address,
    "127.0.0.1",
    "server must bind to loopback only",
  );

  const realImage = path.join(os.tmpdir(), "ths-server-test.png");
  fs.writeFileSync(realImage, Buffer.from("89504e470d0a1a0a", "hex"));
  const served = await fetch(
    `http://127.0.0.1:${PORT}/api/image?path=${encodeURIComponent(realImage)}`,
  );
  assert.equal(served.status, 200, "a real image path must still be served");
  assert.equal(served.headers.get("content-type"), "image/png");

  // Non-image paths must be refused rather than streamed back.
  for (const target of [
    "/etc/hosts",
    "/etc/passwd",
    `${os.homedir()}/.ssh/id_rsa`,
  ]) {
    const response = await fetch(
      `http://127.0.0.1:${PORT}/api/image?path=${encodeURIComponent(target)}`,
    );
    assert.equal(
      response.status,
      400,
      `${target} must not be served through /api/image`,
    );
  }

  // Polled status responses must never be reused from cache, and an episode with no
  // state file must read as not existing rather than erroring.
  const status = await fetch(
    `http://127.0.0.1:${PORT}/api/episode-state?dir=${encodeURIComponent("/nope/missing-episode")}`,
  );
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.deepEqual(await status.json(), { exists: false });

  // The lockfile enforces one server per repo: a second start must be refused while
  // the first is alive.
  assert.ok(fs.existsSync(lockPath), "the running server must hold the lock");
  let conflictReported = false;
  startServer({
    port: PORT + 1,
    lockPath,
    onPortConflict: () => {
      conflictReported = true;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(conflictReported, "a second instance must be refused via the lock");

  fs.rmSync(realImage, { force: true });
  console.log("server test passed");
}

main()
  .catch((error) => {
    console.error("server test failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    server.close();
  });
