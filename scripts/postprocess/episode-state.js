const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readJson, writeJson } = require("./utils");

// One file per episode holds everything the tool persists: the lifecycle phase, the
// long-running jobs, and the accumulated run data (suggestions, links, fix memory).
// Every read and write goes through this module, serialized per episode, so no two
// writers can clobber each other's half of the file.
const STATE_FILE_NAME = "postprocess-state.json";
const STATE_VERSION = 1;

// Lifecycle phases are irreversible milestones, not runtime status - renders and clip
// runs live in jobs, each with its own status. "discovered" is stored only once
// something real persists (a job started before any run); a fresh episode has no file.
const PHASES = ["discovered", "generating", "generated"];
const PHASE_TRANSITIONS = {
  "": ["discovered", "generating"],
  discovered: ["generating"],
  // generating -> generating covers a re-approve after a crash mid-run.
  generating: ["generating", "generated"],
  generated: ["generating"],
};

const ACTIVE_JOB_STATUSES = new Set(["waiting", "running"]);
const TERMINAL_JOB_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

// One id per server process. A job recorded as running under any other id belongs to
// a process that no longer exists (the lockfile guarantees a single live server), so
// it can be marked interrupted deterministically - no freshness heuristics.
const serverRunId = crypto.randomUUID();

function statePath(episodeDir) {
  return path.join(episodeDir, STATE_FILE_NAME);
}

// Per-episode promise chain: read-modify-write cycles never interleave, so a job
// progress tick can't resurrect a file that a reset deleted a moment earlier.
const lockQueues = new Map();

function withLock(episodeDir, fn) {
  const key = path.resolve(episodeDir);
  const previous = lockQueues.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const settled = run.catch(() => {});
  lockQueues.set(key, settled);
  settled.then(() => {
    if (lockQueues.get(key) === settled) {
      lockQueues.delete(key);
    }
  });
  return run;
}

// In-memory registry of jobs started by this process, for duplicate-run refusal, the
// Electron quit guard, and cancellation.
const activeJobs = new Map();

function jobKey(episodeDir, jobName) {
  return `${path.resolve(episodeDir)}\n${jobName}`;
}

function readStateFileRaw(episodeDir) {
  const filePath = statePath(episodeDir);
  return fs.existsSync(filePath) ? readJson(filePath, null) : null;
}

function writeStateFile(episodeDir, state) {
  state.version = STATE_VERSION;
  state.updatedAt = new Date().toISOString();
  writeJson(statePath(episodeDir), state);
  return state;
}

function assertPhaseTransition(from, to) {
  if (!PHASES.includes(to)) {
    throw new Error(`Unknown episode phase: ${to}`);
  }
  const allowed = PHASE_TRANSITIONS[from || ""] || [];
  if (!allowed.includes(to)) {
    throw new Error(
      `Illegal episode phase transition: ${from || "(none)"} -> ${to}`,
    );
  }
}

function sweepInterruptedJobs(state) {
  let changed = false;
  for (const [name, job] of Object.entries(state.jobs || {})) {
    if (ACTIVE_JOB_STATUSES.has(job?.status) && job.runId !== serverRunId) {
      state.jobs[name] = {
        ...job,
        status: "interrupted",
        interruptedAt: new Date().toISOString(),
        error: `${name} was interrupted (server process restarted or exited)`,
      };
      changed = true;
    }
  }
  return changed;
}

// Returns the episode's state, or null when none exists. Jobs left "running" by a
// dead process are marked interrupted on the way through, and persisted as such.
function readState(episodeDir) {
  return withLock(episodeDir, () => {
    const state = readStateFileRaw(episodeDir);
    if (!state) {
      return null;
    }
    if (sweepInterruptedJobs(state)) {
      writeStateFile(episodeDir, state);
    }
    return state;
  });
}

// Read-modify-write under the episode's lock. fn receives the current state (null when
// none exists) and returns the state to persist; returning null skips the write - the
// conditional-update idiom for "only if a state file already exists". A phase change
// in the returned state is validated against the transition table.
function updateState(episodeDir, fn) {
  return withLock(episodeDir, () => {
    const previous = readStateFileRaw(episodeDir);
    const next = fn(previous);
    if (!next) {
      return null;
    }
    if ((previous?.phase || "") !== next.phase) {
      assertPhaseTransition(previous?.phase || "", next.phase);
    }
    return writeStateFile(episodeDir, next);
  });
}

// Records a job as running (or waiting) and registers it in-process. Creates the state
// file when the job is the first thing to persist (a clip run before any Approve).
function startJob(episodeDir, jobName, fields = {}, abortController = null) {
  return withLock(episodeDir, () => {
    const key = jobKey(episodeDir, jobName);
    if (activeJobs.has(key)) {
      throw new Error(`${jobName} is already in progress for this episode`);
    }
    const state = readStateFileRaw(episodeDir) || {
      phase: "discovered",
      jobs: {},
    };
    state.jobs = state.jobs || {};
    state.jobs[jobName] = {
      status: "running",
      ...fields,
      runId: serverRunId,
      startedAt: new Date().toISOString(),
    };
    writeStateFile(episodeDir, state);
    activeJobs.set(key, { abortController });
    return state.jobs[jobName];
  });
}

// Progress tick. A no-op when the state file is gone (reset) or the job slot no longer
// carries this process's runId - a straggler write must never resurrect either.
function patchJob(episodeDir, jobName, patch) {
  return withLock(episodeDir, () => {
    const state = readStateFileRaw(episodeDir);
    const job = state?.jobs?.[jobName];
    if (!job || job.runId !== serverRunId) {
      return null;
    }
    state.jobs[jobName] = { ...job, ...patch };
    writeStateFile(episodeDir, state);
    return state.jobs[jobName];
  });
}

// Replaces the whole job slot with its terminal form, so no stale field (a transient
// error, an old percent) can ride along into the finished state. Always unregisters
// the in-process entry, even when the file is gone.
function finishJob(episodeDir, jobName, finalFields) {
  if (!TERMINAL_JOB_STATUSES.has(finalFields?.status)) {
    return Promise.reject(
      new Error(
        `finishJob needs a terminal status, got: ${finalFields?.status}`,
      ),
    );
  }
  return withLock(episodeDir, () => {
    activeJobs.delete(jobKey(episodeDir, jobName));
    const state = readStateFileRaw(episodeDir);
    const job = state?.jobs?.[jobName];
    if (!job || job.runId !== serverRunId) {
      return null;
    }
    state.jobs[jobName] = {
      runId: job.runId,
      startedAt: job.startedAt,
      ...finalFields,
      finishedAt: new Date().toISOString(),
    };
    writeStateFile(episodeDir, state);
    return state.jobs[jobName];
  });
}

function isJobActive(episodeDir, jobName) {
  return activeJobs.has(jobKey(episodeDir, jobName));
}

function getJobAbortController(episodeDir, jobName) {
  return activeJobs.get(jobKey(episodeDir, jobName))?.abortController || null;
}

function hasActiveJobs() {
  return activeJobs.size > 0;
}

function hasActiveJobsFor(episodeDir) {
  const prefix = `${path.resolve(episodeDir)}\n`;
  return [...activeJobs.keys()].some((key) => key.startsWith(prefix));
}

// Clear & Restart: with the file gone, the episode reads as fresh and nothing can
// resurrect the old state (job stragglers no-op via the runId check). The legacy
// two-file layout is swept too, so old episodes clean themselves up when reset.
function resetEpisodeState(episodeDir) {
  return withLock(episodeDir, () => {
    if (hasActiveJobsFor(episodeDir)) {
      throw new Error(
        "A render or clip generation is in progress for this episode - wait or cancel first",
      );
    }
    fs.rmSync(statePath(episodeDir), { force: true });
    fs.rmSync(path.join(episodeDir, "postprocess-report.json"), {
      force: true,
    });
    fs.rmSync(path.join(episodeDir, "video-status.json"), { force: true });
  });
}

module.exports = {
  STATE_FILE_NAME,
  statePath,
  readState,
  updateState,
  startJob,
  patchJob,
  finishJob,
  isJobActive,
  getJobAbortController,
  hasActiveJobs,
  hasActiveJobsFor,
  resetEpisodeState,
};
