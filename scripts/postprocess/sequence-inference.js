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

// Seasons follow the calendar half-year: the first episode released after 31 Dec or
// 30 Jun starts a new season. Comparing half-year indices (rather than "is the target
// month January/July") makes a break that skips clean over a boundary month - June to
// August, December to February - still roll the season.
function halfYearIndex(instant, timezone) {
  const parts = zonedDateParts(instant, timezone);
  return parts.year * 2 + (parts.month >= 7 ? 1 : 0);
}

// The one exception to the mid-year boundary: a non-leap year starting on a Thursday
// has only 25 first-half Wednesdays, so an unbroken winter season takes its 26th
// episode on the first Wednesday of July rather than ending one short. The year-end
// boundary has no such exception - the first Wednesday of a year always starts a
// season. (A calendar date's weekday is timezone-independent.)
function isFirstWednesdayOfJuly(instant, timezone) {
  const parts = zonedDateParts(instant, timezone);
  return (
    parts.month === 7 &&
    parts.day <= 7 &&
    new Date(Date.UTC(parts.year, 6, parts.day)).getUTCDay() === 3
  );
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
  const lastParts = zonedDateParts(last.date, timezone);

  let cursor;
  if (Number(seasonNumber) > last.season) {
    // A future season starts at the first release slot after its calendar boundary.
    // Seasons can end short of 26 episodes (a boundary rollover cuts them off), so
    // counting the old season's phantom remaining episodes would land weeks late.
    // A spilled 26th episode sits on the first Wednesday of July but belongs to the
    // winter season, so the season's own half is one back from its date's half.
    const lastSeasonHalfIndex =
      halfYearIndex(last.date, timezone) -
      (last.episode >= MAX_EPISODES_PER_SEASON &&
      isFirstWednesdayOfJuly(last.date, timezone)
        ? 1
        : 0);
    const targetHalfIndex =
      lastSeasonHalfIndex + (Number(seasonNumber) - last.season);
    const boundaryYear = Math.floor(targetHalfIndex / 2);
    const boundaryMonth = targetHalfIndex % 2 === 0 ? 1 : 7;
    cursor = new Date(Date.UTC(boundaryYear, boundaryMonth - 1, 1));
    // Releases go out on Wednesdays (a calendar date's weekday is zone-independent).
    while (cursor.getUTCDay() !== 3) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    // A winter season may have spilled its 26th episode onto the first Wednesday of
    // July; the next season starts on the first Wednesday after the last episode.
    const lastDayValue = Date.UTC(
      lastParts.year,
      lastParts.month - 1,
      lastParts.day,
    );
    while (cursor.getTime() <= lastDayValue) {
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
    cursor.setUTCDate(cursor.getUTCDate() + (Number(episodeNumber) - 1) * 7);
  } else {
    // Same (or an earlier) season: weekly cadence from the last known episode.
    // Step by calendar days rather than a fixed number of hours, so the release time
    // stays put when the target lands on the other side of a DST change.
    const weekDelta =
      episodeOrdinal(seasonNumber, episodeNumber) -
      episodeOrdinal(last.season, last.episode);
    cursor = new Date(
      Date.UTC(lastParts.year, lastParts.month - 1, lastParts.day),
    );
    cursor.setUTCDate(cursor.getUTCDate() + weekDelta * 7);
  }

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

  let nextSeason = last.season;
  let nextEpisode = last.episode + 1;
  let reason = "increment";

  const crossedBoundary =
    halfYearIndex(nextPublish, timezone) > halfYearIndex(last.date, timezone);
  const crossedYear =
    zonedDateParts(nextPublish, timezone).year >
    zonedDateParts(last.date, timezone).year;
  // Episode 26 may spill onto the first Wednesday of July when the first half ran out
  // of Wednesdays at 25; it may never spill into a new year.
  const spillsIntoJuly =
    last.episode === MAX_EPISODES_PER_SEASON - 1 &&
    !crossedYear &&
    isFirstWednesdayOfJuly(nextPublish, timezone);

  if (last.episode >= MAX_EPISODES_PER_SEASON) {
    nextSeason = last.season + 1;
    nextEpisode = 1;
    reason = "max-episodes";
  } else if (crossedBoundary && !spillsIntoJuly) {
    nextSeason = last.season + 1;
    nextEpisode = 1;
    reason = "calendar-boundary";
  } else if (crossedBoundary && spillsIntoJuly) {
    reason = "spill-into-july";
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
