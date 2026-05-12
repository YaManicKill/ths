const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function expandHome(inputPath) {
  if (!inputPath) {
    return inputPath;
  }

  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function normalizeCode(value) {
  return String(value || "").padStart(2, "0");
}

function normalizeChapterFilename(name) {
  return String(name || "").replace(/\u00a0/g, " ");
}

function isChapterInfoFilename(name) {
  const normalized = normalizeChapterFilename(name);
  return /\s*[\-\u2013\u2014]\s*chapter info\.txt$/i.test(normalized);
}

function chapterTitleFromFilename(name) {
  const normalized = normalizeChapterFilename(name);
  return normalized
    .replace(/\s*[\-\u2013\u2014]\s*chapter info\.txt$/i, "")
    .trim();
}

function walkDirectories(rootDir, maxDepth = 4) {
  const results = [];

  function walk(currentDir, depth) {
    if (depth > maxDepth) {
      return;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        results.push(fullPath);
        walk(fullPath, depth + 1);
      }
    }
  }

  walk(rootDir, 0);
  return results;
}

function findEpisodeFolder(episodesRoot, seasonCode, episodeCode) {
  const root = expandHome(episodesRoot);
  if (!isDirectory(root)) {
    throw new Error(`Episodes root was not found: ${root}`);
  }

  const targetMp3 = `ths-${seasonCode}-${episodeCode}.mp3`;
  const candidateDirs = [root, ...walkDirectories(root, 4)];
  const candidates = [];

  for (const dir of candidateDirs) {
    const mp3Path = path.join(dir, targetMp3);
    if (!isFile(mp3Path)) {
      continue;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }

    const hasChapter = entries.some(
      (entry) => entry.isFile() && isChapterInfoFilename(entry.name),
    );
    const hasMd = entries.some(
      (entry) => entry.isFile() && /\.md$/i.test(entry.name),
    );
    const hasVtt = entries.some(
      (entry) => entry.isFile() && /\.vtt$/i.test(entry.name),
    );
    const score = (hasChapter ? 4 : 0) + (hasMd ? 2 : 0) + (hasVtt ? 2 : 0);

    candidates.push({ dir, score });
  }

  candidates.sort((a, b) => b.score - a.score || a.dir.localeCompare(b.dir));

  if (candidates.length > 0) {
    return candidates[0].dir;
  }

  throw new Error(
    `Could not find episode folder containing ${targetMp3} under ${root}`,
  );
}

function findLatestAvailableEpisode(episodesRoot) {
  const root = expandHome(episodesRoot);
  if (!isDirectory(root)) {
    throw new Error(`Episodes root was not found: ${root}`);
  }

  const candidateDirs = [root, ...walkDirectories(root, 4)];
  const matches = [];

  for (const dir of candidateDirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const match = entry.name.match(/^ths-(\d{2})-(\d{2})\.mp3$/i);
      if (!match) {
        continue;
      }

      const season = Number(match[1]);
      const episode = Number(match[2]);
      if (!Number.isFinite(season) || !Number.isFinite(episode)) {
        continue;
      }

      matches.push({
        dir,
        season,
        episode,
      });
    }
  }

  if (matches.length === 0) {
    throw new Error(`Could not find any ths-SS-EE.mp3 files under ${root}`);
  }

  matches.sort((a, b) => b.season - a.season || b.episode - a.episode);
  const latest = matches[0];

  return {
    seasonCode: String(latest.season).padStart(2, "0"),
    episodeCode: String(latest.episode).padStart(2, "0"),
  };
}

function resolveTranscriptPair(folderPath, chapterBaseName) {
  const mdPath = path.join(folderPath, `${chapterBaseName}.md`);
  const vttPath = path.join(folderPath, `${chapterBaseName}.vtt`);

  if (isFile(mdPath) && isFile(vttPath)) {
    return { transcriptMdPath: mdPath, transcriptVttPath: vttPath };
  }

  let files = [];
  try {
    files = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch {
    files = [];
  }

  const mdCandidates = files
    .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
    .map((entry) => path.join(folderPath, entry.name));

  const vttCandidates = files
    .filter((entry) => entry.isFile() && /\.vtt$/i.test(entry.name))
    .map((entry) => path.join(folderPath, entry.name));

  const pickMd =
    mdCandidates.find((candidate) => !/readme\.md$/i.test(candidate)) ||
    mdCandidates[0];
  const pickVtt = vttCandidates[0];

  if (!pickMd || !pickVtt) {
    throw new Error(
      "Could not find matching transcript .md and .vtt files in episode folder",
    );
  }

  return {
    transcriptMdPath: pickMd,
    transcriptVttPath: pickVtt,
  };
}

function discoverEpisodeInputs({ episodesRoot, season, episode }) {
  const seasonCode = normalizeCode(season);
  const episodeCode = normalizeCode(episode);

  if (!/^\d{2}$/.test(seasonCode) || !/^\d{2}$/.test(episodeCode)) {
    throw new Error("Season and episode must be numeric and up to 2 digits");
  }

  const folderPath = findEpisodeFolder(episodesRoot, seasonCode, episodeCode);
  const mp3Path = path.join(folderPath, `ths-${seasonCode}-${episodeCode}.mp3`);

  let entries = [];
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch {
    throw new Error(`Unable to read episode folder: ${folderPath}`);
  }

  const chapterEntry = entries.find(
    (entry) => entry.isFile() && isChapterInfoFilename(entry.name),
  );
  const chapterBaseName = chapterEntry
    ? chapterTitleFromFilename(chapterEntry.name)
    : "";
  const transcripts = resolveTranscriptPair(folderPath, chapterBaseName);
  const episodeTitle = path.basename(
    transcripts.transcriptMdPath,
    path.extname(transcripts.transcriptMdPath),
  );

  return {
    folderPath,
    mp3Path,
    transcriptMdPath: transcripts.transcriptMdPath,
    transcriptVttPath: transcripts.transcriptVttPath,
    episodeTitle,
  };
}

function discoverLatestEpisodeInputs({ episodesRoot }) {
  const latest = findLatestAvailableEpisode(episodesRoot);
  return discoverEpisodeInputs({
    episodesRoot,
    season: latest.seasonCode,
    episode: latest.episodeCode,
  });
}

module.exports = {
  discoverEpisodeInputs,
  discoverLatestEpisodeInputs,
  expandHome,
};
