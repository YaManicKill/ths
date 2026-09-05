const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const episodeState = require("./episode-state");
const { readJson, writeJson } = require("./utils");

function tempEpisodeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ths-episode-state-"));
}

async function main() {
  // A fresh episode has no state at all.
  const dir = tempEpisodeDir();
  assert.equal(await episodeState.readState(dir), null);

  // Conditional updates skip the write when no state exists yet.
  const skipped = await episodeState.updateState(dir, (state) =>
    state ? { ...state, clipSuggestions: [] } : null,
  );
  assert.equal(skipped, null);
  assert.ok(!fs.existsSync(episodeState.statePath(dir)));

  // Approve creates the file in "generating"; jumping straight to "generated" is the
  // bug the transition table exists to catch.
  await assert.rejects(
    episodeState.updateState(dir, () => ({ phase: "generated", jobs: {} })),
    /Illegal episode phase transition/,
  );
  await episodeState.updateState(dir, (state) => ({
    ...(state || {}),
    phase: "generating",
    jobs: {},
  }));
  const generating = await episodeState.readState(dir);
  assert.equal(generating.phase, "generating");
  assert.equal(generating.version, 1);

  await episodeState.updateState(dir, (state) => ({
    ...state,
    phase: "generated",
    clipSuggestions: [{ title: "A clip" }],
  }));
  // Re-approve loops back; a phase kept as-is needs no transition at all.
  await episodeState.updateState(dir, (state) => ({
    ...state,
    phase: "generating",
  }));
  await episodeState.updateState(dir, (state) => ({
    ...state,
    phase: "generated",
  }));

  // Jobs: start registers in-process and refuses a duplicate.
  assert.equal(episodeState.hasActiveJobs(), false);
  const abort = new AbortController();
  const job = await episodeState.startJob(
    dir,
    "clipGeneration",
    { total: 3, current: 0 },
    abort,
  );
  assert.equal(job.status, "running");
  assert.ok(job.runId);
  assert.equal(episodeState.isJobActive(dir, "clipGeneration"), true);
  assert.equal(episodeState.hasActiveJobsFor(dir), true);
  assert.equal(
    episodeState.getJobAbortController(dir, "clipGeneration"),
    abort,
  );
  await assert.rejects(
    episodeState.startJob(dir, "clipGeneration", {}),
    /already in progress/,
  );

  await episodeState.patchJob(dir, "clipGeneration", {
    current: 2,
    error: "transient",
  });

  // Reset is refused while a job runs.
  await assert.rejects(episodeState.resetEpisodeState(dir), /in progress/);

  // Finishing replaces the whole slot, so the transient error above cannot ride along
  // into the completed state - the exact bug the old merge-and-patch dance had.
  const finished = await episodeState.finishJob(dir, "clipGeneration", {
    status: "completed",
    total: 3,
    current: 3,
  });
  assert.equal(finished.status, "completed");
  assert.equal(finished.error, undefined);
  assert.ok(finished.finishedAt);
  assert.equal(episodeState.isJobActive(dir, "clipGeneration"), false);
  await assert.rejects(
    episodeState.finishJob(dir, "mp4Render", { status: "running" }),
    /terminal status/,
  );

  // A job left "running" by another process is marked interrupted on first read.
  const stale = readJson(episodeState.statePath(dir), {});
  stale.jobs.mp4Render = { status: "running", runId: "dead-process" };
  writeJson(episodeState.statePath(dir), stale);
  const swept = await episodeState.readState(dir);
  assert.equal(swept.jobs.mp4Render.status, "interrupted");
  assert.match(swept.jobs.mp4Render.error, /interrupted/);
  assert.equal(
    readJson(episodeState.statePath(dir), {}).jobs.mp4Render.status,
    "interrupted",
    "the interruption must be persisted, not just reported",
  );
  assert.equal(swept.jobs.clipGeneration.status, "completed");

  // Reset deletes the file, and a straggler progress write must not resurrect it.
  await episodeState.resetEpisodeState(dir);
  assert.ok(!fs.existsSync(episodeState.statePath(dir)));
  const straggler = await episodeState.patchJob(dir, "clipGeneration", {
    current: 3,
  });
  assert.equal(straggler, null);
  assert.ok(!fs.existsSync(episodeState.statePath(dir)));

  // A job can be the first thing that persists (clips before any Approve): the file
  // appears in "discovered".
  const preRun = await episodeState.startJob(dir, "mp4Render", { percent: 0 });
  assert.equal(preRun.status, "running");
  assert.equal((await episodeState.readState(dir)).phase, "discovered");
  await episodeState.finishJob(dir, "mp4Render", {
    status: "cancelled",
  });

  // Reset also sweeps the legacy two-file layout.
  writeJson(path.join(dir, "postprocess-report.json"), { old: true });
  writeJson(path.join(dir, "video-status.json"), { old: true });
  await episodeState.resetEpisodeState(dir);
  assert.ok(!fs.existsSync(path.join(dir, "postprocess-report.json")));
  assert.ok(!fs.existsSync(path.join(dir, "video-status.json")));

  // Concurrent read-modify-writes serialize; none of the increments may be lost.
  const counterDir = tempEpisodeDir();
  await episodeState.updateState(counterDir, () => ({
    phase: "generating",
    jobs: {},
    counter: 0,
  }));
  await Promise.all(
    Array.from({ length: 25 }, () =>
      episodeState.updateState(counterDir, (state) => ({
        ...state,
        counter: state.counter + 1,
      })),
    ),
  );
  assert.equal((await episodeState.readState(counterDir)).counter, 25);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(counterDir, { recursive: true, force: true });
  console.log("episode-state test passed");
}

main().catch((error) => {
  console.error("episode-state test failed:", error.message);
  process.exit(1);
});
