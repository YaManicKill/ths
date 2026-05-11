const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..", "..");
const episodesRoot = path.join(projectRoot, "content", "episode");

const acronymMap = {
  sos: "SoS",
  goty: "GOTY",
  hm: "HM",
  acnh: "ACNH",
  dlc: "DLC",
  poot: "PoOT",
};

const hostAliases = {
  "Al McKinlay": "Al",
  "Raschelle Dellaney": "Raschelle",
};

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
  const andIndex = words.findIndex((word) =>
    /^and$/i.test(word.replace(/[^a-z]/gi, "")),
  );

  if (andIndex >= 0 && andIndex + 1 < words.length) {
    return words.slice(0, andIndex + 2).join(" ");
  }

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
    .filter((name) => !["We", "The", "An", "A"].includes(name));
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

function getHostCounts(episodes) {
  const counts = new Map();

  for (const episode of episodes) {
    const uniqueNames = new Set(episode.hostNames);
    for (const name of uniqueNames) {
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([name, episodeCount]) => ({ name, episodeCount }))
    .sort(
      (a, b) => b.episodeCount - a.episodeCount || a.name.localeCompare(b.name),
    );
}

module.exports = {
  projectRoot,
  formatSeconds,
  getEpisodeData,
  getHostCounts,
};
