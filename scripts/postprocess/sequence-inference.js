const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_TIMEZONE,
  formatZonedTimestamp,
  getUpcomingWednesdayDateString,
  zonedDateParts,
} = require("./utils");

const MAX_EPISODES_PER_SEASON = 26;

function walkIndexFiles(rootDir) {
  const results = [];

  function walk(currentDir) {
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name === "index.md") {
        results.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return results;
}

function extractFrontmatter(text) {
  const match = String(text || "").match(/^---\n([\s\S]*?)\n---\n/);
  return match ? match[1] : "";
}

function extractField(frontmatterText, field) {
  const regex = new RegExp(`^${field}:\\s*\"?([^\"\\n]+)\"?$`, "m");
  const match = frontmatterText.match(regex);
  return match ? match[1].trim() : null;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function loadEpisodeRecords(contentEpisodeRoot) {
  const indexFiles = walkIndexFiles(contentEpisodeRoot);
  const records = [];

  for (const filePath of indexFiles) {
    let raw = "";
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const frontmatter = extractFrontmatter(raw);
    if (!frontmatter) {
      continue;
    }

    const season = toNumber(extractField(frontmatter, "season"));
    const episode = toNumber(extractField(frontmatter, "episode"));
    const dateRaw = extractField(frontmatter, "date");

    if (!season || !episode || !dateRaw) {
      continue;
    }

    const dateValue = new Date(dateRaw);
    if (Number.isNaN(dateValue.getTime())) {
      continue;
    }

    records.push({
      season,
      episode,
      date: dateValue,
      filePath,
    });
  }

  records.sort((a, b) => a.date.getTime() - b.date.getTime());
  return records;
}

function isSeasonBoundaryMonth(month) {
  return month === 1 || month === 7;
}

function episodeOrdinal(season, episode) {
  return (Number(season) - 1) * MAX_EPISODES_PER_SEASON + Number(episode);
}

function inferPublishDateForEpisode({
  contentEpisodeRoot,
  seasonNumber,
  episodeNumber,
  releaseTimeLocal,
  timezone = DEFAULT_TIMEZONE,
}) {
  const records = loadEpisodeRecords(contentEpisodeRoot);
  if (records.length === 0) {
    return getUpcomingWednesdayDateString({
      time: releaseTimeLocal,
      timezone,
    });
  }

  const last = records[records.length - 1];
  const targetOrdinal = episodeOrdinal(seasonNumber, episodeNumber);
  const lastOrdinal = episodeOrdinal(last.season, last.episode);
  const weekDelta = targetOrdinal - lastOrdinal;

  // Step by calendar days rather than a fixed number of hours, so the release time
  // stays put when the target lands on the other side of a DST change.
  const lastParts = zonedDateParts(last.date, timezone);
  const cursor = new Date(
    Date.UTC(lastParts.year, lastParts.month - 1, lastParts.day),
  );
  cursor.setUTCDate(cursor.getUTCDate() + weekDelta * 7);

  return formatZonedTimestamp({
    year: cursor.getUTCFullYear(),
    month: cursor.getUTCMonth() + 1,
    day: cursor.getUTCDate(),
    time: releaseTimeLocal,
    timezone,
  });
}

function inferNextSeasonEpisode({
  contentEpisodeRoot,
  releaseTimeLocal,
  timezone = DEFAULT_TIMEZONE,
  publishDate,
}) {
  const records = loadEpisodeRecords(contentEpisodeRoot);
  if (records.length === 0) {
    return {
      seasonCode: "01",
      episodeCode: "01",
      seasonNumber: 1,
      episodeNumber: 1,
      reason: "no-existing-episodes",
    };
  }

  const last = records[records.length - 1];

  let nextPublish = null;
  if (publishDate) {
    nextPublish = new Date(publishDate);
  }

  if (!nextPublish || Number.isNaN(nextPublish.getTime())) {
    const nextPublishText = getUpcomingWednesdayDateString({
      time: releaseTimeLocal,
      timezone,
    });
    nextPublish = new Date(nextPublishText);
  }

  const nextMonth = nextPublish.getMonth() + 1;
  const lastMonth = last.date.getMonth() + 1;

  let nextSeason = last.season;
  let nextEpisode = last.episode + 1;
  let reason = "increment";

  if (last.episode >= 26) {
    nextSeason = last.season + 1;
    nextEpisode = 1;
    reason = "max-episodes";
  } else if (isSeasonBoundaryMonth(nextMonth) && nextMonth !== lastMonth) {
    nextSeason = last.season + 1;
    nextEpisode = 1;
    reason = "calendar-boundary";
  }

  return {
    seasonCode: String(nextSeason).padStart(2, "0"),
    episodeCode: String(nextEpisode).padStart(2, "0"),
    seasonNumber: nextSeason,
    episodeNumber: nextEpisode,
    reason,
    basedOn: {
      lastSeason: last.season,
      lastEpisode: last.episode,
      lastDate: last.date.toISOString(),
      nextPublish: nextPublish.toISOString(),
      lastFilePath: last.filePath,
    },
  };
}

module.exports = {
  inferPublishDateForEpisode,
  inferNextSeasonEpisode,
  loadEpisodeRecords,
};
