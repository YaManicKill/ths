#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const episodesRoot = path.join(__dirname, "..", "content", "episode");
const args = process.argv.slice(2);
let topCount = 10;
let showFile = false;
const acronymMap = {
  sos: "SoS",
  goty: "GOTY",
  hm: "HM",
  acnh: "ACNH",
  dlc: "DLC",
};

function envFlagIsTrue(value) {
  if (typeof value !== "string") {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

if (
  envFlagIsTrue(process.env.npm_config_showfile) ||
  envFlagIsTrue(process.env.npm_config_show_file)
) {
  showFile = true;
}

for (const arg of args) {
  if (arg === "--show-file" || arg === "--showFile") {
    showFile = true;
    continue;
  }

  if (arg === "--hide-file" || arg === "--hideFile") {
    showFile = false;
    continue;
  }

  if (/^\d+$/.test(arg)) {
    topCount = Number.parseInt(arg, 10);
    continue;
  }

  console.error(`Unknown argument: ${arg}`);
  console.error(
    "Usage: node scripts/top-durations.js [count] [--show-file|--hide-file|--showFile|--hideFile]",
  );
  process.exit(1);
}

if (!Number.isInteger(topCount) || topCount <= 0) {
  console.error(
    "Please provide a positive integer for how many episodes to show.",
  );
  process.exit(1);
}

function walkMarkdownFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files;
}

function toSeconds(duration) {
  const parts = duration.split(":").map(Number);
  const [hours, minutes, seconds] = parts;
  return hours * 3600 + minutes * 60 + seconds;
}

function formatSeconds(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
}

function formatDate(dateText) {
  if (!dateText) {
    return "Unknown date";
  }

  const parsed = new Date(dateText);
  if (Number.isNaN(parsed.getTime())) {
    return dateText;
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

function getMatch(content, regex) {
  const match = content.match(regex);
  return match ? match[1] : null;
}

function extractHostsFromDescription(description) {
  if (!description) {
    return "Unknown hosts";
  }

  const words = description.trim().split(/\s+/);
  const andIndex = words.findIndex((word) =>
    /^and$/i.test(word.replace(/[^a-z]/gi, "")),
  );

  if (andIndex >= 0 && andIndex + 1 < words.length) {
    return words.slice(0, andIndex + 2).join(" ");
  }

  return description;
}

function toTitleCase(value) {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      const lowerWord = word.toLowerCase();
      if (acronymMap[lowerWord]) {
        return acronymMap[lowerWord];
      }

      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function formatEpisodeNameFromPath(relativePath) {
  const pathWithoutExt = relativePath.replace(/\.md$/i, "");
  const rawName =
    path.basename(pathWithoutExt) === "index"
      ? path.basename(path.dirname(pathWithoutExt))
      : path.basename(pathWithoutExt);

  const withoutNumberPrefix = rawName.replace(/^\d+(?:-\d+)*-?/, "");
  const normalized = (withoutNumberPrefix || rawName)
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return toTitleCase(normalized);
}

if (!fs.existsSync(episodesRoot)) {
  console.error(`Episode directory not found: ${episodesRoot}`);
  process.exit(1);
}

const markdownFiles = walkMarkdownFiles(episodesRoot);
const durations = [];

for (const filePath of markdownFiles) {
  const content = fs.readFileSync(filePath, "utf8");
  const durationText = getMatch(
    content,
    /^podcast_duration:\s*"?([0-9]{1,2}:[0-9]{2}:[0-9]{2})"?/m,
  );

  if (!durationText) {
    continue;
  }

  const title =
    getMatch(content, /^title:\s*"?(.+?)"?\s*$/m) ||
    path.basename(filePath, ".md");
  const description =
    getMatch(content, /^Description:\s*"?(.+?)"?\s*$/m) ||
    getMatch(content, /^description:\s*"?(.+?)"?\s*$/m);
  const dateText = getMatch(content, /^date:\s*"?(.+?)"?\s*$/m);

  durations.push({
    title,
    durationText,
    seconds: toSeconds(durationText),
    formattedDate: formatDate(dateText),
    hosts: extractHostsFromDescription(description),
    relativePath: path.relative(path.join(__dirname, ".."), filePath),
    episodeName: formatEpisodeNameFromPath(
      path.relative(path.join(__dirname, ".."), filePath),
    ),
  });
}

durations.sort((a, b) => b.seconds - a.seconds);

const top = durations.slice(0, topCount);

if (top.length === 0) {
  console.log("No episodes with podcast_duration found.");
  process.exit(0);
}

console.log(`Top ${top.length} longest episodes:`);
for (const [index, item] of top.entries()) {
  const rank = String(index + 1).padStart(2, " ");
  const baseLine = `${rank}. ${formatSeconds(item.seconds)} | ${item.title} | ${item.hosts}`;
  const locationField = showFile ? item.relativePath : item.episodeName;
  console.log(`${baseLine} | ${locationField} | ${item.formattedDate}`);
}
