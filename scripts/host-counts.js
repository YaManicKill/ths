#!/usr/bin/env node

const { getEpisodeData, getHostStats } = require("./lib/episode-data");

let episodes;
try {
  episodes = getEpisodeData();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const hostStats = getHostStats(episodes);

if (hostStats.length === 0) {
  console.log("No hosts found.");
  process.exit(0);
}

console.log(`Hosts by episode count (${hostStats.length} total):`);
for (const [index, host] of hostStats.entries()) {
  const rank = String(index + 1).padStart(2, " ");
  console.log(
    `${rank}. ${host.name} | episodes: ${host.episodeCount} | avg: ${host.averageDuration}`,
  );
}
