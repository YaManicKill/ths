const fs = require("node:fs");
const path = require("node:path");
const {
  attachChapterDurations,
  episodeTitleFromInputs,
  extractSpeakerNames,
  formatSecondsToHhmmss,
  parseChaptersFromMp3,
  parseEpisodeFromMp3Path,
} = require("./parsers");
const { resolveChapterImages } = require("./image-resolver");
const { findWordMatches } = require("./transcript-check");
const { generateVideoFromChapters } = require("./video");
const { buildClipSuggestions } = require("./clip-suggestions");
const { loadPostprocessConfig } = require("./config");
const { resolveLlm } = require("./llm");
const {
  applyTranscriptFixes,
  reviewTranscriptCached,
  selectTranscriptFixes,
} = require("./transcript-review");
const { suggestClipsLlmCached } = require("./clip-suggestions-llm");
const { analyzeAudioCached, buildAudioQcWarnings } = require("./audio-qc");
const episodeState = require("./episode-state");
const {
  assertToolAvailable,
  chapterImageOverridesPath,
  createOrCheckoutEpisodeBranch,
  ensureDir,
  fileExists,
  getUpcomingWednesdayDateString,
  normalizeTitle,
  readJson,
  runCommand,
  slugify,
  titleCase,
  writeJson,
} = require("./utils");

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

function checkChapterEmbedSupport() {
  if (!assertToolAvailable("python3")) {
    return {
      ok: false,
      error:
        "python3 was not found in PATH, and it is required to embed chapter images into the MP3",
    };
  }

  const result = runCommand("python3", ["-c", "import mutagen"]);
  if (result.status !== 0) {
    return {
      ok: false,
      error:
        "The python3 'mutagen' package is required to embed chapter images into the MP3. Install with: python3 -m pip install --user mutagen",
    };
  }

  return { ok: true };
}

const WORK_DIR_RETENTION_MS = 24 * 60 * 60 * 1000;

// Discovery runs on every UI input change, and a run leaves chapter MP4 segments behind,
// so without pruning this grows by hundreds of megabytes per episode.
function pruneStaleWorkDirs(workRoot, keepDir) {
  const cutoff = Date.now() - WORK_DIR_RETENTION_MS;

  let entries = [];
  try {
    entries = fs.readdirSync(workRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !/^(?:ths-\d{2}-\d{2}|rerender)-\d+$/.test(entry.name)
    ) {
      continue;
    }

    const fullPath = path.join(workRoot, entry.name);
    if (fullPath === keepDir) {
      continue;
    }

    const timestamp = Number(entry.name.split("-").pop());
    if (Number.isFinite(timestamp) && timestamp > cutoff) {
      continue;
    }

    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } catch {
      // A dir still in use by another run will be picked up next time.
    }
  }
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

function decodeHtmlEntities(input) {
  return String(input || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, codePoint) => {
      const value = Number(codePoint);
      return Number.isFinite(value) ? String.fromCodePoint(value) : _;
    });
}

async function findExactSteamStoreUrl(title) {
  const normalizedTitle = normalizeTitle(title);
  if (!normalizedTitle) {
    return null;
  }

  const searchUrl = new URL("https://store.steampowered.com/search/suggest");
  searchUrl.searchParams.set("term", title);
  searchUrl.searchParams.set("f", "games");
  searchUrl.searchParams.set("cc", "GB");
  searchUrl.searchParams.set("realm", "1");
  searchUrl.searchParams.set("l", "english");

  const response = await fetch(searchUrl, {
    headers: {
      "user-agent": "ths-postprocess-bot/1.0",
      accept: "text/html, */*;q=0.1",
    },
  });

  if (!response.ok) {
    return null;
  }

  const html = await response.text();
  const anchorPattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorPattern)) {
    const href = match[1];
    const anchorHtml = match[2];
    const titleMatch = /class="match_name"[^>]*>([\s\S]*?)<\/div>/i.exec(
      anchorHtml,
    );
    const rawName = titleMatch
      ? titleMatch[1]
      : anchorHtml.replace(/<[^>]+>/g, " ");
    const candidateTitle = decodeHtmlEntities(rawName)
      .replace(/\s+/g, " ")
      .trim();

    if (normalizeTitle(candidateTitle) !== normalizedTitle) {
      continue;
    }

    const cleanUrl = decodeHtmlEntities(href).replace(/\/?\?snr=.*$/i, "/");
    return cleanUrl;
  }

  return null;
}

async function resolveHiddenChapterLinks(chapters) {
  const hiddenTitles = chapters
    .filter((chapter) => chapter.toc === false)
    .map((chapter) => chapter.title);

  const uniqueTitles = [
    ...new Set(
      hiddenTitles.map((title) => String(title || "").trim()).filter(Boolean),
    ),
  ];
  const resolvedLinks = new Map();

  for (const title of uniqueTitles) {
    try {
      const url = await findExactSteamStoreUrl(title);
      resolvedLinks.set(title, url);
    } catch {
      resolvedLinks.set(title, null);
    }
  }

  return hiddenTitles.map((title) => ({
    title,
    url: resolvedLinks.get(title) || null,
  }));
}

// Rows with a URL render as markdown links; title-only rows (a game with no Steam
// page, a link to fill in later) render as bare text, matching the hand-edited style.
function sanitizeShownotesLinks(rawLinks) {
  if (!Array.isArray(rawLinks)) {
    return null;
  }
  return rawLinks
    .map((link) => ({
      title: String(link?.title || "").trim(),
      url: String(link?.url || "").trim() || null,
    }))
    .filter((link) => link.title || link.url);
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
  chapters,
  links,
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

  const fallbackHiddenLinks = chapters
    .filter((chapter) => chapter.toc === false)
    .map((chapter) => ({ title: chapter.title, url: null }));
  const resolvedLinks =
    Array.isArray(links) && links.length > 0 ? links : fallbackHiddenLinks;

  if (resolvedLinks.length === 0) {
    lines.push("[]()");
  } else {
    for (const link of resolvedLinks) {
      if (link.url) {
        lines.push(`[${link.title}](${link.url})`);
      } else {
        lines.push(link.title);
      }
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

function resolveSeasonInfo(episodeMeta) {
  const targetSeasonCode = String(episodeMeta.seasonCode || "").padStart(
    2,
    "0",
  );
  const targetSeasonNumber = Number(episodeMeta.seasonNumber);

  if (!Number.isFinite(targetSeasonNumber) || targetSeasonNumber < 1) {
    throw new Error(`Invalid season number: ${targetSeasonCode}`);
  }

  const seasonOrder = ["spring", "summer", "autumn", "winter"];
  const zeroBased = targetSeasonNumber - 1;
  const index = zeroBased % seasonOrder.length;
  const year = Math.floor(zeroBased / seasonOrder.length) + 1;

  const derivedSlug = seasonOrder[index];
  return {
    year: String(year),
    seasonName: titleCase(derivedSlug),
    folder: slugify(derivedSlug),
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
  const config = loadPostprocessConfig(repoRoot, inputOptions.configPath);

  const onProgress = inputOptions.onProgress || (() => {});

  validateInputs(inputOptions);

  const tools = {
    ffmpeg: assertToolAvailable("ffmpeg"),
    ffprobe: assertToolAvailable("ffprobe"),
  };

  if (!tools.ffmpeg || !tools.ffprobe) {
    throw new Error(
      "ffmpeg and ffprobe are required and were not found in PATH",
    );
  }

  // Only a warning here; runPipeline rejects the same condition before it writes.
  const embedSupport = checkChapterEmbedSupport();
  if (!embedSupport.ok) {
    onProgress(`Warning: ${embedSupport.error}`);
  }

  onProgress("Parsing episode metadata...");

  const episodeMeta = parseEpisodeFromMp3Path(inputOptions.mp3Path);
  const seasonInfo = resolveSeasonInfo(episodeMeta);

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
  const chapterTitles = new Set(chapters.map((c) => normalizeTitle(c.title)));
  const speakers = extractSpeakerNames(transcriptMdText, 2, chapterTitles);
  const description = buildDescription({
    explicitDescription: inputOptions.description,
    speakers,
    mainTopic,
  });

  onProgress("Looking up exact Steam links...");
  const hiddenLinks = await resolveHiddenChapterLinks(chapters);
  const hiddenLinkTitles = hiddenLinks.map((link) => link.title);

  // The chapter before Outro is almost always the main topic, and the main topic is
  // almost always a game - so it gets a prefilled shownotes row too, deleted in the UI
  // on the weeks it is not.
  const shownotesLinkSeeds = [...hiddenLinks];
  const outroIndex = chapters.findIndex(
    (chapter) => normalizeTitle(chapter.title) === "outro",
  );
  const mainTopicChapter = outroIndex > 0 ? chapters[outroIndex - 1] : null;
  if (
    mainTopicChapter &&
    !hiddenLinks.some(
      (link) =>
        normalizeTitle(link.title) === normalizeTitle(mainTopicChapter.title),
    )
  ) {
    let mainTopicUrl = null;
    try {
      mainTopicUrl = await findExactSteamStoreUrl(mainTopicChapter.title);
    } catch {
      // No Steam page is fine; the row still seeds with just the title.
    }
    shownotesLinkSeeds.push({
      title: mainTopicChapter.title,
      url: mainTopicUrl,
    });
  }

  const stat = fs.statSync(inputOptions.mp3Path);
  const podcastBytes = stat.size;
  const podcastDuration = formatSecondsToHhmmss(audioDurationSeconds);

  const dateString =
    inputOptions.publishDate ||
    getUpcomingWednesdayDateString({
      time: config.releaseTimeLocal,
      timezone: config.timezone,
    });

  onProgress("Extracting cover art...");

  const workRoot = path.join(repoRoot, ".cache", "postprocess");
  const workDir = path.join(workRoot, `${episodeMeta.guid}-${Date.now()}`);
  ensureDir(workDir);
  pruneStaleWorkDirs(workRoot, workDir);

  const fallbackCoverPath = path.join(workDir, "fallback-cover.jpg");
  const coverExtracted = extractCoverArt(
    inputOptions.mp3Path,
    fallbackCoverPath,
  );
  if (!coverExtracted) {
    createFallbackImage(fallbackCoverPath);
  }

  onProgress("Resolving chapter images...");

  const persistentOverrides = readJson(chapterImageOverridesPath(repoRoot), {});

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

  // Warning-only, like the profanity check. The first pass decodes the whole episode
  // (~a minute for a long one); after that it is cached until the MP3 changes.
  let audioQc = { enabled: false, warnings: [] };
  try {
    onProgress("Analyzing audio levels (first pass takes about a minute)...");
    const analysis = await analyzeAudioCached({
      cacheDir: path.join(workRoot, "audio-qc"),
      mp3Path: inputOptions.mp3Path,
    });
    audioQc = {
      enabled: true,
      ...analysis,
      warnings: buildAudioQcWarnings(analysis),
    };
    onProgress(
      analysis.fromCache
        ? "Audio QC: using cached analysis for this MP3"
        : `Audio QC: ${audioQc.warnings.length} warning(s)`,
    );
  } catch (error) {
    audioQc = { enabled: true, error: error.message, warnings: [] };
    onProgress(`Warning: audio QC failed: ${error.message}`);
  }

  const clipSuggestions = buildClipSuggestions({
    transcriptMdText,
    transcriptVttText,
    maxSuggestions: 8,
  });

  return {
    episodeMeta,
    seasonInfo,
    episodeTitle,
    mainTopic,
    speakers,
    description,
    hiddenLinks,
    hiddenLinkTitles,
    shownotesLinkSeeds,
    podcastBytes,
    podcastDuration,
    dateString,
    chapters: chaptersWithImages,
    profanityMatches,
    audioQc,
    transcriptMdText,
    transcriptVttText,
    clipSuggestions,
    workDir,
    fallbackCoverPath,
  };
}

async function runPipeline(inputOptions = {}) {
  const repoRoot = inputOptions.repoRoot || path.resolve(__dirname, "..", "..");
  const config = loadPostprocessConfig(repoRoot, inputOptions.configPath);

  const onProgress = inputOptions.onProgress || (() => {});

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
  let videoPath;
  if (inputOptions.episodeFolderPath) {
    videoPath = path.join(
      inputOptions.episodeFolderPath,
      `ths-${episodeMeta.seasonCode}-${episodeMeta.episodeCode}.mp4`,
    );
  } else {
    const episodeFolderFromMp3 = path.dirname(inputOptions.mp3Path);
    videoPath = path.join(
      episodeFolderFromMp3,
      `ths-${episodeMeta.seasonCode}-${episodeMeta.episodeCode}.mp4`,
    );
  }

  // Medium-confidence fixes the user applied after an earlier run exist only in the
  // episode's previous state; a re-run regenerates the transcripts from source, so
  // without carrying them forward those approved corrections would silently vanish.
  const previousState = await episodeState.readState(episodeDir);
  const carriedTranscriptFixes = Array.isArray(
    previousState?.appliedTranscriptFixes,
  )
    ? previousState.appliedTranscriptFixes
    : [];

  // Shownotes links: the UI's edited list wins; a re-run without one keeps the last
  // run's links rather than resetting to the auto-resolved Steam set.
  const shownotesLinks =
    sanitizeShownotesLinks(inputOptions.shownotesLinks) ??
    sanitizeShownotesLinks(previousState?.shownotesLinks) ??
    discovered.shownotesLinkSeeds ??
    discovered.hiddenLinks;

  const report = {
    episode: {
      ...episodeMeta,
      title: episodeTitle,
      mainTopic: discovered.mainTopic,
      season: seasonInfo,
      outputDirectory: episodeDir,
      podcastPath,
      videoPath,
    },
    appliedTranscriptFixes: carriedTranscriptFixes,
    shownotesLinks,
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
    clipSuggestions: discovered.clipSuggestions,
    coverImagePath: discovered.fallbackCoverPath,
    mp3ChapterImages: {
      completed: false,
      chaptersEmbedded: 0,
      backupPath: null,
    },
  };

  // Fail before the branch and files exist, rather than part-way through the run.
  const embedSupport = checkChapterEmbedSupport();
  if (!embedSupport.ok) {
    throw new Error(embedSupport.error);
  }

  // The sources are re-read here rather than reusing discovery-time text, because the
  // user may have edited them between discovery and approval.
  const sourceTranscriptMdText = fs.readFileSync(
    inputOptions.transcriptMdPath,
    "utf8",
  );
  const sourceTranscriptVttText = fs.readFileSync(
    inputOptions.transcriptVttPath,
    "utf8",
  );

  // The AI check runs at generation rather than discovery, so the LLM is consulted once
  // per approved run instead of on every input tweak. Warning-only: a missing key, a
  // network failure, or a provider outage must never block the run.
  let transcriptReview = { enabled: false, findings: [] };
  const llm = resolveLlm(config);
  if (llm) {
    onProgress(
      `Checking transcript for likely mistranscriptions (${llm.model})...`,
    );
    try {
      const review = await reviewTranscriptCached({
        cacheDir: path.join(
          repoRoot,
          ".cache",
          "postprocess",
          "transcript-review",
        ),
        transcriptMdText: sourceTranscriptMdText,
        transcriptVttText: sourceTranscriptVttText,
        chapters: chaptersWithImages,
        llm,
        hostNames: config.hostNames,
        complete: inputOptions.llmComplete,
      });
      transcriptReview = { enabled: true, ...review };
      onProgress(
        review.fromCache
          ? "Transcript check: using cached result for this transcript"
          : `Transcript check: ${review.findings.length} potential issue(s) found`,
      );
    } catch (error) {
      transcriptReview = { enabled: true, findings: [], error: error.message };
      onProgress(`Warning: transcript check failed: ${error.message}`);
    }
  }
  report.transcriptReview = transcriptReview;

  onProgress("Creating git branch...");

  const branchResult = createOrCheckoutEpisodeBranch(
    repoRoot,
    episodeMeta.seasonCode,
    episodeMeta.episodeCode,
  );

  report.gitBranch = {
    name: branchResult.branchName,
    created: branchResult.created,
  };

  onProgress("Creating episode directory...");

  ensureDir(episodeDir);

  // The phase flips to "generating" before the first episode file is written, so a
  // crash mid-run is distinguishable from a finished one. Prior run data rides along
  // untouched until the completed run replaces it.
  await episodeState.updateState(episodeDir, (state) => ({
    ...(state || {}),
    phase: "generating",
    jobs: state?.jobs || {},
  }));

  onProgress("Writing transcripts...");

  // The raw transcripts are written and staged before any fixes land, so `git diff`
  // on the episode files shows exactly what the AI (and later ticked fixes) changed
  // against the pristine version. Warning-only: a staging hiccup must not block a run.
  fs.writeFileSync(
    path.join(episodeDir, "transcript.md"),
    sourceTranscriptMdText,
    "utf8",
  );
  fs.writeFileSync(
    path.join(episodeDir, "transcript.vtt"),
    sourceTranscriptVttText,
    "utf8",
  );
  const stageResult = runCommand(
    "git",
    [
      "add",
      "--",
      path.join(episodeDir, "transcript.md"),
      path.join(episodeDir, "transcript.vtt"),
    ],
    { cwd: repoRoot },
  );
  if (stageResult.status !== 0) {
    onProgress(
      `Warning: could not stage raw transcripts for diffing: ${stageResult.stderr || stageResult.stdout}`,
    );
  }

  // Fixes rewrite only the copies written into the episode folder; the source
  // transcripts are never touched.
  const selectedFixes = selectTranscriptFixes(
    transcriptReview,
    inputOptions.transcriptFixes,
  );
  const selectedQuotes = new Set(selectedFixes.map((fix) => fix.quote));
  const transcriptFixes = [
    ...selectedFixes,
    ...carriedTranscriptFixes.filter((fix) => !selectedQuotes.has(fix.quote)),
  ];
  const mdFixResult = applyTranscriptFixes(
    sourceTranscriptMdText,
    transcriptFixes,
  );
  const vttFixResult = applyTranscriptFixes(
    sourceTranscriptVttText,
    transcriptFixes,
  );

  fs.writeFileSync(
    path.join(episodeDir, "transcript.md"),
    mdFixResult.text,
    "utf8",
  );
  fs.writeFileSync(
    path.join(episodeDir, "transcript.vtt"),
    vttFixResult.text,
    "utf8",
  );

  report.transcriptFixes = {
    attempted: transcriptFixes.length,
    mdApplied: mdFixResult.applied.length,
    vttApplied: vttFixResult.applied.length,
    mdMissed: mdFixResult.missed.map((fix) => fix.quote),
    vttMissed: vttFixResult.missed.map((fix) => fix.quote),
  };

  if (transcriptFixes.length > 0) {
    onProgress(
      `Applied transcript fixes: ${mdFixResult.applied.length} in transcript.md, ${vttFixResult.applied.length} in transcript.vtt`,
    );
  }
  for (const fix of mdFixResult.missed) {
    onProgress(
      `Warning: fix not applied to transcript.md (text not found verbatim): "${fix.quote}"`,
    );
  }
  for (const fix of vttFixResult.missed) {
    onProgress(
      `Warning: fix not applied to transcript.vtt (text not found verbatim): "${fix.quote}"`,
    );
  }

  // AI clip picks replace the heuristic suggestions when available, using the fixed
  // transcripts so quotes match the burned-in subtitles. Warning-only, like the check:
  // any failure falls back to the heuristics from discovery.
  let clipSuggestions = discovered.clipSuggestions;
  let clipSource = "heuristic";
  // A 429 from the check means the quota is gone for every request in this run;
  // asking again for clips would just re-walk the retry waits before failing too.
  const quotaExhausted = /\(429\)/.test(transcriptReview.error || "");
  if (llm && quotaExhausted) {
    onProgress(
      "Skipping AI clip selection: the transcript check already hit the API quota limit; keeping heuristic suggestions",
    );
  } else if (llm) {
    onProgress(`Selecting clip suggestions (${llm.model})...`);
    try {
      const llmClips = await suggestClipsLlmCached({
        cacheDir: path.join(
          repoRoot,
          ".cache",
          "postprocess",
          "clip-suggestions",
        ),
        transcriptMdText: mdFixResult.text,
        transcriptVttText: vttFixResult.text,
        llm,
        complete: inputOptions.llmComplete,
      });
      if (llmClips.suggestions.length > 0) {
        clipSuggestions = llmClips.suggestions;
        clipSource = "llm";
        onProgress(
          llmClips.fromCache
            ? "Clip suggestions: using cached AI picks for this transcript"
            : `Clip suggestions: ${llmClips.suggestions.length} picked by AI`,
        );
      } else {
        onProgress(
          "Warning: AI clip selection returned nothing usable; keeping heuristic suggestions",
        );
      }
    } catch (error) {
      onProgress(`Warning: AI clip selection failed: ${error.message}`);
    }
  }
  report.clipSuggestions = clipSuggestions;
  report.clipSource = clipSource;

  onProgress("Updating MP3 chapter images...");

  const { backupPath } = embedChapterImagesIntoMp3({
    mp3Path: inputOptions.mp3Path,
    chapters: chaptersWithImages,
    workDir,
  });

  report.mp3ChapterImages.completed = true;
  report.mp3ChapterImages.chaptersEmbedded = chaptersWithImages.length;
  report.mp3ChapterImages.backupPath = backupPath;

  const indexMarkdown = buildIndexMarkdown({
    episodeTitle,
    episodeMeta,
    seasonInfo,
    description,
    // Read after the embed, which changes the file size.
    podcastBytes: fs.statSync(inputOptions.mp3Path).size,
    podcastPath,
    podcastDuration,
    dateString,
    chapters: chaptersWithImages,
    links: shownotesLinks,
    author: config.defaultAuthor,
  });

  onProgress("Writing shownotes...");

  fs.writeFileSync(path.join(episodeDir, "index.md"), indexMarkdown, "utf8");

  // Content is on disk: the episode is "generated". The MP4 render is a job on top of
  // that phase, not a phase of its own - re-renders and clip runs happen here too.
  await episodeState.updateState(episodeDir, (state) => ({
    ...report,
    phase: "generated",
    jobs: state?.jobs || {},
  }));

  if (inputOptions.skipVideo) {
    onProgress("Skipping MP4 generation (requested)");
    report.videoStatus = { skipped: true };
  } else {
    onProgress("Generating MP4 video...");
    await episodeState.startJob(episodeDir, "mp4Render", { percent: 0 });

    setImmediate(async () => {
      try {
        await generateVideoFromChapters({
          chapters: chaptersWithImages,
          mp3Path: inputOptions.mp3Path,
          outputPath: videoPath,
          workDir: path.join(workDir, "video"),
          onProgress: (progress) => {
            episodeState
              .patchJob(episodeDir, "mp4Render", {
                status: "running",
                ...progress,
              })
              .catch(() => {});
          },
        });
        await episodeState.finishJob(episodeDir, "mp4Render", {
          status: "completed",
          videoPath,
          percent: 100,
        });

        // The chapter segments are the bulk of the scratch space and the muxed MP4 is
        // already written, so drop them as soon as the render succeeds.
        fs.rmSync(path.join(workDir, "video"), {
          recursive: true,
          force: true,
        });
      } catch (error) {
        // Log error but don't throw since we're background
        console.error("Video generation error:", error.message);
        await episodeState
          .finishJob(episodeDir, "mp4Render", {
            status: "failed",
            error: error.message,
          })
          .catch(() => {});
      }
    });

    report.videoStatus = { started: true };
  }

  if (inputOptions.skipVideo) {
    onProgress("Pipeline complete.");
  } else {
    onProgress("Pipeline complete. Video generation running in background...");
  }

  return {
    report,
    indexMarkdown,
  };
}

module.exports = {
  runPipeline,
  discoverEpisodeData,
};
