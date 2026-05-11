#!/usr/bin/env node

const { getEpisodeData, getHostCounts } = require("./lib/episode-data");

let episodes;
try {
  episodes = getEpisodeData();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const hostCounts = getHostCounts(episodes);

if (hostCounts.length === 0) {
  console.log("No hosts found.");
  process.exit(0);
}

console.log(`Hosts by episode count (${hostCounts.length} total):`);
for (const [index, host] of hostCounts.entries()) {
  const rank = String(index + 1).padStart(2, " ");
  console.log(`${rank}. ${host.name} | ${host.episodeCount}`);
}
