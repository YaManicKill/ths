const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function getUpcomingWednesdayDateString({
  now = new Date(),
  time = "19:00:00",
  timezoneOffset = "+01:00",
} = {}) {
  const [hour, minute, second] = time.split(":").map((part) => Number(part));

  const target = new Date(now);
  target.setHours(0, 0, 0, 0);

  const day = target.getDay();
  let diff = (3 - day + 7) % 7;
  if (diff === 0) {
    diff = 7;
  }

  target.setDate(target.getDate() + diff);

  const year = target.getFullYear();
  const month = String(target.getMonth() + 1).padStart(2, "0");
  const date = String(target.getDate()).padStart(2, "0");

  const hh = String(Number.isFinite(hour) ? hour : 19).padStart(2, "0");
  const mm = String(Number.isFinite(minute) ? minute : 0).padStart(2, "0");
  const ss = String(Number.isFinite(second) ? second : 0).padStart(2, "0");

  return `${year}-${month}-${date}T${hh}:${mm}:${ss}${timezoneOffset}`;
}

module.exports = {
  assertToolAvailable,
  ensureDir,
  fileExists,
  getUpcomingWednesdayDateString,
  normalizeTitle,
  readJson,
  runCommand,
  slugify,
  titleCase,
  writeJson,
};
