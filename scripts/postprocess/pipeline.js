const fs = require("node:fs");
const path = require("node:path");
const {
  attachChapterDurations,
  episodeTitleFromInputs,
  extractSpeakerNames,
  extractUrls,
  formatSecondsToHhmmss,
  parseChaptersFromMp3,
  parseEpisodeFromMp3Path,
} = require("./parsers");
const { resolveChapterImages } = require("./image-resolver");
const { findWordMatches } = require("./transcript-check");
const { generateVideoFromChapters } = require("./video");
const {
  assertToolAvailable,
  ensureDir,
  fileExists,
  getUpcomingWednesdayDateString,
  normalizeTitle,
  readJson,
  runCommand,
  slugify,
  writeJson,
} = require("./utils");

const DEFAULT_CONFIG = {
  defaultAuthor: "Al McKinlay",
  defaultSeasonNumber: "11",
  releaseTimeLocal: "19:00:00",
  timezoneOffset: "+01:00",
  outputRoot: "content/episode",
  videoOutputRoot: "content/episode-videos",
  seasonMap: {
    11: {
      year: "3",
      seasonName: "Autumn",
      folder: "autumn",
    },
  },
  imageOverridesFile: "data/chapter-image-overrides.json",
  profanityWords: [
    "fuck",
    "fucking",
    "shit",
    "bitch",
    "cunt",
    "asshole",
    "motherfucker",
  ],
};

function getAudioDurationSeconds(mp3Path) {
  const result = runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    mp3Path,
  ]);

  if (result.status !== 0) {
    throw new Error(`ffprobe failed: ${result.stderr || result.stdout}`);
  }

  const seconds = Number(result.stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("Could not parse duration from ffprobe output");
  }

  return seconds;
}

function extractCoverArt(mp3Path, outputPath) {
  const result = runCommand("ffmpeg", [
    "-y",
    "-i",
    mp3Path,
    "-an",
    "-vframes",
    "1",
    outputPath,
  ]);

  return result.status === 0 && fileExists(outputPath);
}

function createFallbackImage(outputPath) {
  const result = runCommand("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=1080x1080",
    "-frames:v",
    "1",
    outputPath,
  ]);

  return result.status === 0 && fileExists(outputPath);
}

function ensureMp3Backup(mp3Path) {
  const backupPath = `${mp3Path}.bak`;
  if (!fileExists(backupPath)) {
    fs.copyFileSync(mp3Path, backupPath);
  }
  return backupPath;
}

function embedChapterImagesIntoMp3({ mp3Path, chapters, workDir }) {
  const scriptPath = path.join(__dirname, "embed_chapter_images.py");
  if (!fileExists(scriptPath)) {
    throw new Error(`Missing embed script: ${scriptPath}`);
  }

  const backupPath = ensureMp3Backup(mp3Path);

  const payloadPath = path.join(workDir, "chapters-for-mp3.json");
  writeJson(
    payloadPath,
    chapters.map((chapter) => ({
      title: chapter.title,
      startSeconds: chapter.startSeconds,
      endSeconds: chapter.endSeconds,
      toc: chapter.toc,
      imagePath: chapter.imagePath,
    })),
  );

  const result = runCommand("python3", [
    scriptPath,
    "--mp3",
    mp3Path,
    "--chapters-json",
    payloadPath,
  ]);

  if (result.status !== 0) {
    throw new Error(
      `Failed to embed chapter images in MP3: ${result.stderr || result.stdout}`,
    );
  }

  return { backupPath };
}

function pickMainTopic(chapters) {
  if (chapters.length < 2) {
    return chapters[0] ? chapters[0].title : "Main Topic";
  }

  const outroIndex = chapters.findIndex(
    (chapter) => normalizeTitle(chapter.title) === "outro",
  );
  if (outroIndex > 0) {
    return chapters[outroIndex - 1].title;
  }

  return chapters[chapters.length - 2].title;
}

function buildDescription({ explicitDescription, speakers, mainTopic }) {
  if (explicitDescription) {
    return explicitDescription;
  }

  if (speakers.length >= 2) {
    return `${speakers[0]} and ${speakers[1]} talk about ${mainTopic}.`;
  }

  if (speakers.length === 1) {
    return `${speakers[0]} talks about ${mainTopic}.`;
  }

  return `Al and Greg talk about ${mainTopic}.`;
}

function buildIndexMarkdown({
  episodeTitle,
  episodeMeta,
  seasonInfo,
  description,
  podcastPath,
  podcastBytes,
  podcastDuration,
  dateString,
  links,
  chapters,
  author,
}) {
  const lines = [];

  lines.push("---");
  lines.push(`title: \"${episodeTitle.replace(/\"/g, "'")}\"`);
  lines.push(`episode: \"${episodeMeta.episodeNumber}\"`);
  lines.push(`season: \"${episodeMeta.seasonNumber}\"`);
  lines.push(`seasonName: \"${seasonInfo.seasonName}\"`);
  lines.push(`year: \"${seasonInfo.year}\"`);
  lines.push(`Description: \"${description.replace(/\"/g, "'")}\"`);
  lines.push(`guid: \"${episodeMeta.guid}\"`);
  lines.push(`podcast: \"${podcastPath}\"`);
  lines.push(`podcast_bytes: \"${podcastBytes}\"`);
  lines.push(`podcast_duration: \"${podcastDuration}\"`);
  lines.push(`date: ${dateString}`);
  lines.push(`author: \"${author}\"`);
  lines.push("transcript_files: true");
  lines.push("---");
  lines.push("");
  lines.push("## Timings");
  lines.push("");

  for (const chapter of chapters) {
    // Only chapters explicitly marked toc:false are excluded from Timings.
    if (chapter.toc === false) {
      continue;
    }
    lines.push(`${chapter.timeLabel}: ${chapter.title}`);
  }

  lines.push("");
  lines.push("## Links");
  lines.push("");

  if (links.length === 0) {
    lines.push("[]()");
  } else {
    for (const url of links) {
      lines.push(`[${url}](${url})`);
    }
  }

  lines.push("");
  lines.push("## Contact");
  lines.push("");
  lines.push("Al on Mastodon: https://mastodon.scot/@TheScotBot");
  lines.push("Email Us: https://harvestseason.club/contact/");
  lines.push("");

  return lines.join("\n");
}

function loadConfig(repoRoot, configPath) {
  const fullPath = configPath || path.join(repoRoot, "postprocess.config.json");
  const config = fileExists(fullPath) ? readJson(fullPath) : {};
  return {
    ...DEFAULT_CONFIG,
    ...config,
    seasonMap: {
      ...DEFAULT_CONFIG.seasonMap,
      ...(config.seasonMap || {}),
    },
  };
}

function validateInputs(inputs) {
  const required = ["mp3Path", "transcriptMdPath", "transcriptVttPath"];
  for (const key of required) {
    if (!inputs[key]) {
      throw new Error(`Missing required input: ${key}`);
    }
    if (!fileExists(inputs[key])) {
      throw new Error(`Input does not exist: ${inputs[key]}`);
    }
  }
}

// Discovery phase - parse chapters, resolve images, but don't write files
async function discoverEpisodeData(inputOptions = {}) {
  const repoRoot = inputOptions.repoRoot || path.resolve(__dirname, "..", "..");
  const config = loadConfig(repoRoot, inputOptions.configPath);

  const onProgress = inputOptions.onProgress || (() => {});

  validateInputs(inputOptions);

  const tools = {
    ffmpeg: assertToolAvailable("ffmpeg"),
    ffprobe: assertToolAvailable("ffprobe"),
    python3: assertToolAvailable("python3"),
  };

  if (!tools.ffmpeg || !tools.ffprobe) {
    throw new Error(
      "ffmpeg and ffprobe are required and were not found in PATH",
    );
  }

  onProgress("Parsing episode metadata...");

  const episodeMeta = parseEpisodeFromMp3Path(inputOptions.mp3Path);
  const seasonInfo =
    config.seasonMap[episodeMeta.seasonCode] ||
    config.seasonMap[episodeMeta.seasonNumber];

  if (!seasonInfo) {
    throw new Error(
      `No season mapping found for season ${episodeMeta.seasonCode}`,
    );
  }

  const transcriptMdText = fs.readFileSync(
    inputOptions.transcriptMdPath,
    "utf8",
  );
  const transcriptVttText = fs.readFileSync(
    inputOptions.transcriptVttPath,
    "utf8",
  );

  onProgress("Reading MP3 chapters...");
  const baseChapters = parseChaptersFromMp3(inputOptions.mp3Path);
  if (baseChapters.length === 0) {
    throw new Error("No chapters were found in MP3 metadata");
  }

  const audioDurationSeconds = getAudioDurationSeconds(inputOptions.mp3Path);
  const chapters = attachChapterDurations(baseChapters, audioDurationSeconds);

  const episodeTitle = episodeTitleFromInputs({
    explicitTitle: inputOptions.episodeTitle,
    transcriptMdPath: inputOptions.transcriptMdPath,
    mp3Path: inputOptions.mp3Path,
  });
  const mainTopic = pickMainTopic(chapters);
  const speakers = extractSpeakerNames(transcriptMdText, 2);
  const description = buildDescription({
    explicitDescription: inputOptions.description,
    speakers,
    mainTopic,
  });

  const links = extractUrls(transcriptMdText, transcriptVttText);

  const stat = fs.statSync(inputOptions.mp3Path);
  const podcastBytes = stat.size;
  const podcastDuration = formatSecondsToHhmmss(audioDurationSeconds);

  const dateString =
    inputOptions.publishDate ||
    getUpcomingWednesdayDateString({
      time: config.releaseTimeLocal,
      timezoneOffset: config.timezoneOffset,
    });

  onProgress("Extracting cover art...");

  const workRoot = path.join(repoRoot, ".cache", "postprocess");
  const workDir = path.join(workRoot, `${episodeMeta.guid}-${Date.now()}`);
  ensureDir(workDir);

  const fallbackCoverPath = path.join(workDir, "fallback-cover.jpg");
  const coverExtracted = extractCoverArt(
    inputOptions.mp3Path,
    fallbackCoverPath,
  );
  if (!coverExtracted) {
    createFallbackImage(fallbackCoverPath);
  }

  onProgress("Resolving chapter images...");

  const imageOverridesPath = path.isAbsolute(config.imageOverridesFile)
    ? config.imageOverridesFile
    : path.join(repoRoot, config.imageOverridesFile);
  const persistentOverrides = readJson(imageOverridesPath, {});

  const chaptersWithImages = await resolveChapterImages(chapters, {
    cacheDir: path.join(workRoot, "image-cache"),
    fallbackImagePath: fallbackCoverPath,
    repoRoot,
    persistentOverrides,
  });

  onProgress("Checking for profanity...");

  const profanityMatches = {
    transcriptMd: findWordMatches(transcriptMdText, config.profanityWords),
    transcriptVtt: findWordMatches(transcriptVttText, config.profanityWords),
  };

  return {
    episodeMeta,
    seasonInfo,
    episodeTitle,
    mainTopic,
    speakers,
    description,
    links,
    podcastBytes,
    podcastDuration,
    dateString,
    chapters: chaptersWithImages,
    profanityMatches,
    transcriptMdText,
    transcriptVttText,
    workDir,
    fallbackCoverPath,
  };
}

async function runPipeline(inputOptions = {}) {
  const repoRoot = inputOptions.repoRoot || path.resolve(__dirname, "..", "..");
  const config = loadConfig(repoRoot, inputOptions.configPath);

  const onProgress = inputOptions.onProgress || (() => {});

  // Use cached discovery data if provided, otherwise perform discovery
  let discovered;
  if (inputOptions.discoveredData) {
    discovered = inputOptions.discoveredData;
    onProgress("Using previously discovered episode data...");
  } else {
    discovered = await discoverEpisodeData(inputOptions);
  }

  const {
    episodeMeta,
    seasonInfo,
    episodeTitle,
    description,
    links,
    podcastBytes,
    podcastDuration,
    dateString,
    chapters: chaptersWithImages,
    workDir,
  } = discovered;

  const slug = slugify(episodeTitle);
  const episodeFolderName = `${episodeMeta.seasonCode}-${episodeMeta.episodeCode}-${slug}`;
  const episodeDir = path.join(
    repoRoot,
    config.outputRoot,
    `year${seasonInfo.year}`,
    seasonInfo.folder,
    episodeFolderName,
  );

  const podcastPath = `ths/year${seasonInfo.year}/${seasonInfo.folder}/ths-${episodeMeta.seasonCode}-${episodeMeta.episodeCode}.mp3`;
  const indexMarkdown = buildIndexMarkdown({
    episodeTitle,
    episodeMeta,
    seasonInfo,
    description,
    podcastPath,
    podcastBytes,
    podcastDuration,
    dateString,
    links,
    chapters: chaptersWithImages,
    author: config.defaultAuthor,
  });

  // Determine video output path - use discovered episode folder or derive from mp3
  let videoPath;
  if (inputOptions.episodeFolderPath) {
    videoPath = path.join(
      inputOptions.episodeFolderPath,
      `ths-${episodeMeta.seasonCode}-${episodeMeta.episodeCode}.mp4`,
    );
  } else {
    // Derive from mp3Path - the folder containing the mp3 is the episodes folder
    const episodeFolderFromMp3 = path.dirname(inputOptions.mp3Path);
    videoPath = path.join(
      episodeFolderFromMp3,
      `ths-${episodeMeta.seasonCode}-${episodeMeta.episodeCode}.mp4`,
    );
  }

  const report = {
    dryRun: Boolean(inputOptions.dryRun),
    episode: {
      ...episodeMeta,
      title: episodeTitle,
      mainTopic: discovered.mainTopic,
      season: seasonInfo,
      outputDirectory: episodeDir,
      podcastPath,
      videoPath,
    },
    chapterCount: chaptersWithImages.length,
    chapters: chaptersWithImages.map((chapter) => ({
      start: chapter.timeLabel,
      title: chapter.title,
      toc: chapter.toc,
      durationSeconds: chapter.durationSeconds,
      imageSource: chapter.imageSource,
      imagePath: chapter.imagePath,
    })),
    transcriptChecks: {
      totalMatches:
        discovered.profanityMatches.transcriptMd.length +
        discovered.profanityMatches.transcriptVtt.length,
      transcriptMd: discovered.profanityMatches.transcriptMd,
      transcriptVtt: discovered.profanityMatches.transcriptVtt,
    },
    mp3ChapterImages: {
      attempted: !inputOptions.dryRun,
      completed: false,
      chaptersEmbedded: 0,
      backupPath: null,
    },
    notes: [
      "Per-chapter images are embedded into MP3 chapter metadata.",
      "Video generation uses chapter image fallback to MP3 cover when lookup fails.",
    ],
  };

  if (!inputOptions.dryRun) {
    onProgress("Creating episode directory...");

    ensureDir(episodeDir);

    onProgress("Writing shownotes...");

    fs.writeFileSync(path.join(episodeDir, "index.md"), indexMarkdown, "utf8");

    onProgress("Copying transcripts...");

    fs.copyFileSync(
      inputOptions.transcriptMdPath,
      path.join(episodeDir, "transcript.md"),
    );
    fs.copyFileSync(
      inputOptions.transcriptVttPath,
      path.join(episodeDir, "transcript.vtt"),
    );

    onProgress("Updating MP3 chapter images...");

    const { backupPath } = embedChapterImagesIntoMp3({
      mp3Path: inputOptions.mp3Path,
      chapters: chaptersWithImages,
      workDir,
    });

    report.mp3ChapterImages.completed = true;
    report.mp3ChapterImages.chaptersEmbedded = chaptersWithImages.length;
    report.mp3ChapterImages.backupPath = backupPath;

    writeJson(path.join(episodeDir, "postprocess-report.json"), report);
  }

  onProgress("Generating MP4 video...");

  // Start video generation in background (don't await) so response can be sent immediately
  if (!inputOptions.dryRun) {
    // Use setImmediate to start the task asynchronously without blocking
    setImmediate(() => {
      try {
        generateVideoFromChapters({
          chapters: chaptersWithImages,
          mp3Path: inputOptions.mp3Path,
          outputPath: videoPath,
          workDir: path.join(workDir, "video"),
        });
      } catch (error) {
        // Log error but don't throw since we're background
        console.error("Video generation error:", error.message);
      }
    });
  }

  onProgress("Pipeline complete. Video generation running in background...");

  return {
    report,
    indexMarkdown,
  };
}

module.exports = {
  runPipeline,
  discoverEpisodeData,
};
