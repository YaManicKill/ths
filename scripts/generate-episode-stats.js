#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const {
  projectRoot,
  formatSeconds,
  getEpisodeData,
  getHostCounts,
} = require("./lib/episode-data");

let episodes;
try {
  episodes = getEpisodeData();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const hostCounts = getHostCounts(episodes);

const output = {
  generatedAt: new Date().toISOString(),
  totalEpisodes: episodes.length,
  hosts: hostCounts,
  topDurations: episodes.slice(0, 25).map((episode) => ({
    title: episode.title,
    duration: episode.durationText,
    durationSeconds: episode.seconds,
    durationFormatted: formatSeconds(episode.seconds),
    hosts: episode.hosts,
    date: episode.dateText,
    dateFormatted: episode.formattedDate,
    path: episode.relativePath,
    episodeName: episode.episodeName,
  })),
};

const outPath = path.join(projectRoot, "data", "episode-stats.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

console.log(`Wrote ${outPath}`);
console.log(`Episodes: ${output.totalEpisodes}`);
console.log(`Hosts: ${output.hosts.length}`);
