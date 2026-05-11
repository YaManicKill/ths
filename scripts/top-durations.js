#!/usr/bin/env node

const { formatSeconds, getEpisodeData } = require("./lib/episode-data");

const args = process.argv.slice(2);
let topCount = 10;
let showFile = false;

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

let episodes;
try {
  episodes = getEpisodeData();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const top = episodes.slice(0, topCount);

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
