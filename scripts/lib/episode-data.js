const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..", "..");
const episodesRoot = path.join(projectRoot, "content", "episode");
const hostOverridesPath = path.join(projectRoot, "data", "host-overrides.json");

const acronymMap = {
  sos: "SoS",
  goty: "GOTY",
  hm: "HM",
  acnh: "ACNH",
  dlc: "DLC",
  poot: "PoOT",
};

const defaultHostAliases = {
  "Al McKinlay": "Al",
  "Raschelle Dellaney": "Raschelle",
  Kevin: "Kev",
  Keving: "Kev",
  Britney: "Bev",
};

const defaultIgnoredHostNames = ["We", "The", "An", "A"];

function loadHostOverrides() {
  if (!fs.existsSync(hostOverridesPath)) {
    return { aliases: {}, ignoreNames: [] };
  }

  try {
    const raw = fs.readFileSync(hostOverridesPath, "utf8");
    const parsed = JSON.parse(raw);

    return {
      aliases:
        parsed.aliases && typeof parsed.aliases === "object"
          ? parsed.aliases
          : {},
      ignoreNames: Array.isArray(parsed.ignoreNames) ? parsed.ignoreNames : [],
    };
  } catch {
    return { aliases: {}, ignoreNames: [] };
  }
}

const hostOverrides = loadHostOverrides();
const hostAliases = {
  ...defaultHostAliases,
  ...hostOverrides.aliases,
};
const ignoredHostNames = new Set([
  ...defaultIgnoredHostNames,
  ...hostOverrides.ignoreNames,
]);

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

function getMatch(content, regex) {
  const match = content.match(regex);
  return match ? match[1] : null;
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

function extractHostsFromDescription(description) {
  if (!description) {
    return null;
  }

  const words = description.trim().split(/\s+/);

  const hostBoundaryWords = new Set([
    "talk",
    "talks",
    "discuss",
    "discusses",
    "chat",
    "chats",
    "interview",
    "interviews",
    "covers",
    "cover",
    "plays",
    "play",
    "about",
  ]);

  const boundaryIndex = words.findIndex((word) =>
    hostBoundaryWords.has(word.toLowerCase().replace(/[^a-z]/gi, "")),
  );

  if (boundaryIndex > 0) {
    return words.slice(0, boundaryIndex).join(" ");
  }

  const andIndex = words.findIndex((word) =>
    /^and$/i.test(word.replace(/[^a-z]/gi, "")),
  );

  if (andIndex >= 0 && andIndex + 1 < words.length) {
    return words.slice(0, andIndex + 2).join(" ");
  }

  return null;
}

function canonicalizeHostName(name) {
  return hostAliases[name] || name;
}

function normalizeHostToken(token) {
  return token
    .replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isValidHostName(name) {
  return /^[A-Z][a-zA-Z']+(?:\s+[A-Z][a-zA-Z']+){0,2}$/.test(name);
}

function parseHostNames(text) {
  if (!text) {
    return [];
  }

  return text
    .split(/\s*,\s*|\s+and\s+/i)
    .map(normalizeHostToken)
    .filter(Boolean)
    .filter(isValidHostName)
    .map(canonicalizeHostName)
    .filter((name) => !ignoredHostNames.has(name));
}

function formatHostList(names) {
  if (!names || names.length === 0) {
    return "Unknown hosts";
  }

  if (names.length === 1) {
    return names[0];
  }

  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`;
  }

  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function toValidDate(dateText) {
  if (!dateText) {
    return null;
  }

  const parsed = new Date(dateText);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function median(values) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }

  return sorted[middle];
}

function getEpisodeData() {
  if (!fs.existsSync(episodesRoot)) {
    throw new Error(`Episode directory not found: ${episodesRoot}`);
  }

  const markdownFiles = walkMarkdownFiles(episodesRoot);
  const episodes = [];

  for (const filePath of markdownFiles) {
    const content = fs.readFileSync(filePath, "utf8");
    const durationText = getMatch(
      content,
      /^podcast_duration:\s*"?([0-9]{1,2}:[0-9]{2}:[0-9]{2})"?/m,
    );

    if (!durationText) {
      continue;
    }

    const relativePath = path.relative(projectRoot, filePath);
    const title =
      getMatch(content, /^title:\s*"?(.+?)"?\s*$/m) ||
      path.basename(filePath, ".md");
    const description =
      getMatch(content, /^Description:\s*"?(.+?)"?\s*$/m) ||
      getMatch(content, /^description:\s*"?(.+?)"?\s*$/m);
    const author =
      getMatch(content, /^author:\s*"?(.+?)"?\s*$/m) ||
      getMatch(content, /^Author:\s*"?(.+?)"?\s*$/m);
    const dateText = getMatch(content, /^date:\s*"?(.+?)"?\s*$/m);

    const extractedHosts = extractHostsFromDescription(description);
    const hostNamesFromDescription = parseHostNames(extractedHosts);
    const hostNamesFromAuthor = parseHostNames(author);
    const hostNames =
      hostNamesFromDescription.length > 0
        ? hostNamesFromDescription
        : hostNamesFromAuthor;
    const hostsText = formatHostList(hostNames);

    episodes.push({
      title,
      durationText,
      seconds: toSeconds(durationText),
      hosts: hostsText,
      hostNames,
      relativePath,
      episodeName: formatEpisodeNameFromPath(relativePath),
      dateText,
      formattedDate: formatDate(dateText),
    });
  }

  episodes.sort((a, b) => b.seconds - a.seconds);
  return episodes;
}

function getHostStats(episodes) {
  const stats = new Map();

  for (const episode of episodes) {
    const uniqueNames = new Set(episode.hostNames);
    for (const name of uniqueNames) {
      if (!stats.has(name)) {
        stats.set(name, {
          name,
          episodeCount: 0,
          totalDurationSeconds: 0,
          durations: [],
          longestEpisode: null,
          shortestEpisode: null,
        });
      }

      const host = stats.get(name);
      host.episodeCount += 1;
      host.totalDurationSeconds += episode.seconds;
      host.durations.push(episode.seconds);

      if (
        !host.longestEpisode ||
        episode.seconds > host.longestEpisode.seconds
      ) {
        host.longestEpisode = {
          title: episode.title,
          duration: episode.durationText,
          date: episode.formattedDate,
          path: episode.relativePath,
          seconds: episode.seconds,
        };
      }

      if (
        !host.shortestEpisode ||
        episode.seconds < host.shortestEpisode.seconds
      ) {
        host.shortestEpisode = {
          title: episode.title,
          duration: episode.durationText,
          date: episode.formattedDate,
          path: episode.relativePath,
          seconds: episode.seconds,
        };
      }
    }
  }

  return [...stats.values()]
    .map((host) => {
      const averageDurationSeconds = Math.round(
        host.totalDurationSeconds / host.episodeCount,
      );
      const medianDurationSeconds = median(host.durations);

      return {
        name: host.name,
        episodeCount: host.episodeCount,
        totalDuration: formatSeconds(host.totalDurationSeconds),
        averageDuration: formatSeconds(averageDurationSeconds),
        medianDuration:
          medianDurationSeconds === null
            ? "00:00:00"
            : formatSeconds(medianDurationSeconds),
        longestEpisode: host.longestEpisode
          ? {
              title: host.longestEpisode.title,
              duration: host.longestEpisode.duration,
              date: host.longestEpisode.date,
              path: host.longestEpisode.path,
            }
          : null,
        shortestEpisode: host.shortestEpisode
          ? {
              title: host.shortestEpisode.title,
              duration: host.shortestEpisode.duration,
              date: host.shortestEpisode.date,
              path: host.shortestEpisode.path,
            }
          : null,
      };
    })
    .sort(
      (a, b) => b.episodeCount - a.episodeCount || a.name.localeCompare(b.name),
    );
}

function getHostPairStats(episodes) {
  const pairCounts = new Map();

  for (const episode of episodes) {
    const hosts = [...new Set(episode.hostNames)].sort((a, b) =>
      a.localeCompare(b),
    );
    if (hosts.length < 2) {
      continue;
    }

    for (let i = 0; i < hosts.length - 1; i += 1) {
      for (let j = i + 1; j < hosts.length; j += 1) {
        const a = hosts[i];
        const b = hosts[j];
        const key = `${a}|${b}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }

  return [...pairCounts.entries()]
    .map(([key, episodeCount]) => {
      const [hostA, hostB] = key.split("|");
      return {
        hosts: [hostA, hostB],
        pair: `${hostA} and ${hostB}`,
        episodeCount,
      };
    })
    .sort(
      (a, b) => b.episodeCount - a.episodeCount || a.pair.localeCompare(b.pair),
    );
}

function getReleaseGapStats(episodes) {
  const datedEpisodes = episodes
    .map((episode) => ({
      ...episode,
      parsedDate: toValidDate(episode.dateText),
    }))
    .filter((episode) => episode.parsedDate !== null)
    .sort((a, b) => a.parsedDate - b.parsedDate);

  if (datedEpisodes.length < 2) {
    return {
      episodesWithDate: datedEpisodes.length,
      gapCount: 0,
      averageGapDays: 0,
      medianGapDays: 0,
      shortestGap: null,
      longestGap: null,
    };
  }

  const gaps = [];

  for (let index = 1; index < datedEpisodes.length; index += 1) {
    const previous = datedEpisodes[index - 1];
    const current = datedEpisodes[index];
    const days = Number(
      (
        (current.parsedDate - previous.parsedDate) /
        (1000 * 60 * 60 * 24)
      ).toFixed(2),
    );
    gaps.push({
      days,
      from: {
        title: previous.title,
        date: previous.formattedDate,
        path: previous.relativePath,
      },
      to: {
        title: current.title,
        date: current.formattedDate,
        path: current.relativePath,
      },
    });
  }

  const gapValues = gaps.map((gap) => gap.days);
  const averageGapDays = Number(
    (
      gapValues.reduce((sum, value) => sum + value, 0) / gapValues.length
    ).toFixed(2),
  );
  const sortedGapValues = [...gapValues].sort((a, b) => a - b);
  const mid = Math.floor(sortedGapValues.length / 2);
  const medianGapDays =
    sortedGapValues.length % 2 === 0
      ? Number(
          ((sortedGapValues[mid - 1] + sortedGapValues[mid]) / 2).toFixed(2),
        )
      : sortedGapValues[mid];

  const shortestGap = gaps.reduce(
    (best, current) =>
      best === null || current.days < best.days ? current : best,
    null,
  );
  const longestGap = gaps.reduce(
    (best, current) =>
      best === null || current.days > best.days ? current : best,
    null,
  );

  return {
    episodesWithDate: datedEpisodes.length,
    gapCount: gaps.length,
    averageGapDays,
    medianGapDays,
    shortestGap,
    longestGap,
  };
}

function getHostCounts(episodes) {
  return getHostStats(episodes).map(({ name, episodeCount }) => ({
    name,
    episodeCount,
  }));
}

module.exports = {
  projectRoot,
  formatSeconds,
  getEpisodeData,
  getHostStats,
  getHostCounts,
  getHostPairStats,
  getReleaseGapStats,
};
