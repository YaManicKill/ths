const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const DEFAULT_TIMEZONE = "Europe/London";
const CHAPTER_IMAGE_OVERRIDES_FILE = "data/chapter-image-overrides.json";

function chapterImageOverridesPath(repoRoot) {
  return path.join(repoRoot, CHAPTER_IMAGE_OVERRIDES_FILE);
}

function readJson(filePath, fallbackValue = null) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (fallbackValue !== null) {
      return fallbackValue;
    }
    throw error;
  }
}

let writeJsonSequence = 0;

// Write-then-rename, so readers polling the same file (the video status file, the
// episode report) can never observe a truncated half-write - readJson would silently
// hand its fallback back for one, resetting whatever state was being tracked.
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJsonSequence += 1;
  const tempPath = `${filePath}.${process.pid}.${writeJsonSequence}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();

  return {
    status: result.status,
    error: result.error,
    stdout,
    stderr,
  };
}

function runCommandStream(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        const text = String(chunk);
        stdout += text;
        if (typeof options.onStdout === "function") {
          options.onStdout(text);
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        const text = String(chunk);
        stderr += text;
        if (typeof options.onStderr === "function") {
          options.onStderr(text);
        }
      });
    }

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (status) => {
      resolve({
        status,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function assertToolAvailable(command) {
  const result = runCommand("which", [command]);
  return result.status === 0;
}

function titleCase(input) {
  return input
    .split(" ")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function normalizeTitle(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function timezoneOffsetLabel(instant, timezone) {
  const label = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  })
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName").value;

  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(label);
  if (!match) {
    return "+00:00";
  }

  return `${match[1]}${match[2]}:${match[3]}`;
}

function offsetLabelToMinutes(label) {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(label);
  if (!match) {
    return 0;
  }

  const magnitude = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -magnitude : magnitude;
}

function zonedDateParts(instant, timezone = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);

  const value = (type) =>
    Number(parts.find((part) => part.type === type).value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function formatZonedTimestamp({
  year,
  month,
  day,
  time = "19:00:00",
  timezone = DEFAULT_TIMEZONE,
}) {
  const [hour, minute, second] = String(time)
    .split(":")
    .map((part) => Number(part));
  const hh = Number.isFinite(hour) ? hour : 19;
  const mm = Number.isFinite(minute) ? minute : 0;
  const ss = Number.isFinite(second) ? second : 0;

  const wallClockAsUtc = Date.UTC(year, month - 1, day, hh, mm, ss);
  const approximateOffset = timezoneOffsetLabel(
    new Date(wallClockAsUtc),
    timezone,
  );
  // A zone's offset varies by instant, so resolve it against the instant this wall
  // clock actually lands on rather than the naive UTC reading of it.
  const offset = timezoneOffsetLabel(
    new Date(wallClockAsUtc - offsetLabelToMinutes(approximateOffset) * 60_000),
    timezone,
  );

  const pad = (value) => String(value).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hh)}:${pad(mm)}:${pad(ss)}${offset}`;
}

function addCalendarDays({ year, month, day }, days) {
  const cursor = new Date(Date.UTC(year, month - 1, day));
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return {
    year: cursor.getUTCFullYear(),
    month: cursor.getUTCMonth() + 1,
    day: cursor.getUTCDate(),
    weekday: cursor.getUTCDay(),
  };
}

function getUpcomingWednesdayDateString({
  now = new Date(),
  time = "19:00:00",
  timezone = DEFAULT_TIMEZONE,
} = {}) {
  const today = addCalendarDays(zonedDateParts(now, timezone), 0);
  let diff = (3 - today.weekday + 7) % 7;
  if (diff === 0) {
    diff = 7;
  }

  const target = addCalendarDays(today, diff);
  return formatZonedTimestamp({ ...target, time, timezone });
}

// Parses an HTTP Range header against a file size. Returns {start, end} (inclusive
// byte offsets), null when there is no usable range (serve the whole file with 200),
// or "unsatisfiable" (respond 416). Only single ranges are supported; multipart
// ranges are treated as no range, which is a legal downgrade.
function parseByteRange(rangeHeader, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || "").trim());
  if (!match || size <= 0) {
    return null;
  }

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") {
    return null;
  }

  if (rawStart === "") {
    // Suffix form "bytes=-N": the final N bytes.
    const suffixLength = Number(rawEnd);
    if (suffixLength === 0) {
      return "unsatisfiable";
    }
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (start >= size || start > end) {
    return "unsatisfiable";
  }
  return { start, end };
}

function createOrCheckoutEpisodeBranch(repoRoot, seasonCode, episodeCode) {
  const branchName = `ep-${seasonCode}-${episodeCode}`;

  const checkResult = runCommand("git", ["rev-parse", "--verify", branchName], {
    cwd: repoRoot,
  });

  if (checkResult.status !== 0) {
    const createResult = runCommand("git", ["checkout", "-b", branchName], {
      cwd: repoRoot,
    });

    if (createResult.status !== 0) {
      throw new Error(
        `Failed to create git branch "${branchName}": ${createResult.stderr || createResult.stdout}`,
      );
    }

    return { created: true, branchName };
  } else {
    const checkoutResult = runCommand("git", ["checkout", branchName], {
      cwd: repoRoot,
    });

    if (checkoutResult.status !== 0) {
      throw new Error(
        `Failed to checkout git branch "${branchName}": ${checkoutResult.stderr || checkoutResult.stdout}`,
      );
    }

    return { created: false, branchName };
  }
}

module.exports = {
  DEFAULT_TIMEZONE,
  assertToolAvailable,
  chapterImageOverridesPath,
  createOrCheckoutEpisodeBranch,
  ensureDir,
  fileExists,
  formatZonedTimestamp,
  getUpcomingWednesdayDateString,
  normalizeTitle,
  parseByteRange,
  readJson,
  runCommand,
  runCommandStream,
  slugify,
  titleCase,
  writeJson,
  zonedDateParts,
};
