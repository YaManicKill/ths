const fs = require("node:fs");
const path = require("node:path");
const { ensureDir, runCommand, runCommandStream } = require("./utils");
const { ensureRequiredHashtags } = require("./clip-suggestions-llm");
const {
  formatEpisodeDateForOverlay,
  resolveClipBoldFontPath,
  resolveClipFontPath,
  wrapLabelText,
  writeLabelTextFile,
} = require("./clip-text");
const { sliceCuesForClip, writeClipSubtitles } = require("./clip-subtitles");
const { parseVttCues } = require("./vtt");

const CLIP_WIDTH = 1080;
const CLIP_HEIGHT = 1920;
const LABEL_SIDE_MARGIN = 60;

// Title-card overlay: bold title, short brand-orange rule, date beneath. Vertical
// positions are fractions of frame height; the bottom of the frame is reserved for
// subtitles. The title is bottom-anchored on the rule so a two-line title grows upward.
const TITLE_FONT_SIZE = 72;
const TITLE_BOTTOM_Y = 0.105;
// Bold glyphs run wider than the regular-weight 0.52 estimate.
const TITLE_GLYPH_WIDTH_RATIO = 0.58;
const DATE_FONT_SIZE = 40;
const DATE_TOP_Y = 0.133;
const RULE_Y = 0.117;
const RULE_WIDTH = 220;
const RULE_HEIGHT = 8;
const BRAND_ORANGE = "0xeb8807"; // sampled from HarvestSeason-FullLogo-FullColor-01.png

// The clip progress bar: an inset, scrubber-style track floating above the bottom
// edge, filling with brand orange over the clip's duration.
const PROGRESS_BAR_MARGIN_X = 48;
const PROGRESS_BAR_BOTTOM_OFFSET = 40;
const PROGRESS_BAR_HEIGHT = 16;
const PROGRESS_TRACK_COLOR = "black@0.45";

let cachedFilters = null;

function availableFfmpegFilters() {
  if (cachedFilters) {
    return cachedFilters;
  }

  const result = runCommand("ffmpeg", ["-hide_banner", "-filters"]);
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not run ffmpeg to list its filters: ${result.error?.message || result.stderr || "unknown error"}`,
    );
  }

  const names = new Set();
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    // Lines look like: " ... drawtext          V->V       Draw text on top of video."
    const match = /^\s*[A-Z.]+\s+(\S+)\s+\S+->\S+/.exec(line);
    if (match) {
      names.add(match[1]);
    }
  }

  cachedFilters = names;
  return cachedFilters;
}

function assertFfmpegFilters(required) {
  const available = availableFfmpegFilters();
  const missing = required.filter((name) => !available.has(name));
  if (missing.length === 0) {
    return;
  }

  throw new Error(
    `This ffmpeg build is missing the ${missing.join(", ")} filter(s), which are required to draw text on clips. ` +
      "Homebrew's core ffmpeg formula ships without libfreetype/libass; install one that includes them, e.g. " +
      "brew install homebrew-ffmpeg/ffmpeg/ffmpeg",
  );
}

// Filtergraph values pass through two parsers: the graph tokenizer (which splits on
// ":" "," ";" "[" "]" and honors '...' quoting) and then the option parser (where
// backslash, quote and colon are special). One round of backslash escaping satisfies
// only the first parser, which then hands the second a bare separator - an apostrophe
// in a path ("Al's Drive") broke renders that way. So: escape for the option parser
// first, then single-quote the whole value for the tokenizer; quoting protects every
// separator, and an embedded quote is written by closing, escaping, reopening ('\'').
function escapeFilterValue(value) {
  const optionEscaped = String(value).replace(/[\\':]/g, (c) => `\\${c}`);
  return `'${optionEscaped.split("'").join("'\\''")}'`;
}

function buildClipVisualFilter({
  overlay,
  subtitlesFile,
  fontsDir,
  progressBarDurationSeconds,
} = {}) {
  // format=yuv420p: the cover PNG carries an alpha channel through the whole chain, and
  // drawbox silently draws nothing on alpha frames.
  let graph =
    `[0:v]scale=${CLIP_WIDTH}:${CLIP_HEIGHT}:force_original_aspect_ratio=increase,crop=${CLIP_WIDTH}:${CLIP_HEIGHT},boxblur=34:10,eq=saturation=1.12:brightness=-0.05[bg];` +
    `[0:v]scale=${CLIP_WIDTH}:-2:flags=lanczos[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p`;

  // A heavy outline plus soft shadow keeps the text readable on any cover art without
  // needing a background box (which made the overlay read as a subtitle).
  const titleLegibility =
    "borderw=7:bordercolor=black@0.85:shadowx=0:shadowy=4:shadowcolor=black@0.4";
  const dateLegibility =
    "borderw=5:bordercolor=black@0.85:shadowx=0:shadowy=3:shadowcolor=black@0.4";

  if (overlay?.titleTextFile) {
    graph +=
      // expansion=none: overlay text is literal, not a drawtext template ("%" is
      // otherwise an expansion sequence and a title like "50% Done" errors the render).
      `,drawtext=textfile=${escapeFilterValue(overlay.titleTextFile)}` +
      `:fontfile=${escapeFilterValue(overlay.boldFontPath)}` +
      `:expansion=none:fontcolor=white:fontsize=${TITLE_FONT_SIZE}` +
      `:line_spacing=10:text_align=center:${titleLegibility}` +
      `:x=(w-text_w)/2:y=(h*${TITLE_BOTTOM_Y})-text_h`;
  }

  if (overlay?.titleTextFile && overlay?.dateTextFile) {
    graph += `,drawbox=x=(iw-${RULE_WIDTH})/2:y=ih*${RULE_Y}:w=${RULE_WIDTH}:h=${RULE_HEIGHT}:color=${BRAND_ORANGE}:t=fill`;
  }

  if (overlay?.dateTextFile) {
    graph +=
      `,drawtext=textfile=${escapeFilterValue(overlay.dateTextFile)}` +
      `:fontfile=${escapeFilterValue(overlay.fontPath)}` +
      `:expansion=none:fontcolor=white:fontsize=${DATE_FONT_SIZE}` +
      `:${dateLegibility}` +
      `:x=(w-text_w)/2:y=h*${DATE_TOP_Y}`;
  }

  if (subtitlesFile) {
    // fontsdir loads faces straight from disk: fontconfig on macOS resolves "Arial
    // Bold" to the wrong font entirely, so libass must not go through it.
    graph += `,subtitles=filename=${escapeFilterValue(subtitlesFile)}${
      fontsDir ? `:fontsdir=${escapeFilterValue(fontsDir)}` : ""
    }`;
  }

  const barDuration = Number(progressBarDurationSeconds || 0);
  if (barDuration > 1) {
    const barWidth = CLIP_WIDTH - PROGRESS_BAR_MARGIN_X * 2;
    const barY = CLIP_HEIGHT - PROGRESS_BAR_BOTTOM_OFFSET;
    // drawbox cannot animate (its expressions evaluate once), so the fill is a solid
    // strip slid rightward by overlay, whose position IS evaluated per frame. The
    // sliding strip would bleed past the inset's left edge, so that margin is patched
    // back over the top with a copy of the untouched frame region.
    const slide = `${PROGRESS_BAR_MARGIN_X}-w+w*min(t/${barDuration.toFixed(3)}\\,1)`;
    graph +=
      `,drawbox=x=${PROGRESS_BAR_MARGIN_X}:y=${barY}:w=${barWidth}:h=${PROGRESS_BAR_HEIGHT}:color=${PROGRESS_TRACK_COLOR}:t=fill,split[base][patchsrc];` +
      `color=c=${BRAND_ORANGE}:s=${barWidth}x${PROGRESS_BAR_HEIGHT},format=yuv420p[bar];` +
      `[patchsrc]crop=${PROGRESS_BAR_MARGIN_X}:${PROGRESS_BAR_HEIGHT}:0:${barY}[patch];` +
      `[base][bar]overlay=x='${slide}':y=${barY}:shortest=1[withbar];` +
      `[withbar][patch]overlay=x=0:y=${barY}`;
  }

  return `${graph}[vout]`;
}

// Every clip in an episode carries the same overlay: the episode title above a short
// brand-orange rule, with the release date beneath it.
function prepareEpisodeOverlay({ episodeTitle, episodeDateString, workDir }) {
  const titleLines = wrapLabelText({
    text: episodeTitle,
    maxWidthPx: CLIP_WIDTH - LABEL_SIDE_MARGIN * 2,
    fontSize: TITLE_FONT_SIZE,
    glyphWidthRatio: TITLE_GLYPH_WIDTH_RATIO,
    maxLines: 2,
  });
  const dateLine = formatEpisodeDateForOverlay(episodeDateString);

  if (titleLines.length === 0 && !dateLine) {
    return null;
  }

  return {
    titleTextFile:
      titleLines.length > 0
        ? writeLabelTextFile({ lines: titleLines, workDir, name: "title" })
        : null,
    dateTextFile: dateLine
      ? writeLabelTextFile({ lines: [dateLine], workDir, name: "date" })
      : null,
    boldFontPath: resolveClipBoldFontPath(),
    fontPath: resolveClipFontPath(),
    titleLines,
    dateLine,
  };
}

function secondsToFileToken(value) {
  const total = Math.max(0, Math.floor(Number(value || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, "0")}${String(minutes).padStart(2, "0")}${String(seconds).padStart(2, "0")}`;
}

function buildClipSlugText(clipSuggestion) {
  const source = String(
    clipSuggestion?.summary ||
      clipSuggestion?.text ||
      clipSuggestion?.title ||
      "",
  )
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!source) {
    return "clip";
  }

  const stopWords = new Set([
    "the",
    "and",
    "that",
    "this",
    "with",
    "have",
    "from",
    "just",
    "they",
    "them",
    "your",
    "what",
    "when",
    "where",
    "why",
    "how",
    "you",
    "are",
    "was",
    "were",
    "for",
    "into",
    "about",
    "like",
    "really",
    "very",
    "then",
    "than",
    "but",
    "because",
    "there",
    "their",
  ]);

  const allWords = source.split(" ").filter(Boolean);
  const preferredWords = allWords.filter(
    (word) => word.length > 2 && !stopWords.has(word),
  );
  const chosenWords = (
    preferredWords.length > 0 ? preferredWords : allWords
  ).slice(0, 7);
  const slug = chosenWords
    .join("-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "clip";
}

function buildClipVideoOutputName({
  index,
  clipSuggestion,
  extension = ".mp4",
}) {
  const sequence = String(index + 1).padStart(3, "0");
  const startToken = secondsToFileToken(clipSuggestion?.startSeconds);
  const endToken = secondsToFileToken(clipSuggestion?.endSeconds);
  const slug = buildClipSlugText(clipSuggestion).slice(0, 64);
  return `clip-${sequence}-${startToken}-${endToken}-${slug}${extension}`;
}

// Parses ffmpeg's "-progress pipe:2" key=value stream (interleaved with its normal
// stderr logging) and reports each new out_time as seconds, capped at the expected
// duration and strictly increasing.
function makeFfmpegProgressParser({ durationSeconds, onSeconds }) {
  let stderrBuffer = "";
  let lastProgressSeconds = 0;

  return (chunk) => {
    stderrBuffer += chunk;
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("out_time_us=")) {
        continue;
      }

      const microseconds = Number(line.slice("out_time_us=".length));
      if (!Number.isFinite(microseconds)) {
        continue;
      }

      const progressSeconds = Math.max(0, microseconds / 1_000_000);
      if (progressSeconds <= lastProgressSeconds) {
        continue;
      }
      lastProgressSeconds = progressSeconds;
      onSeconds(Math.min(durationSeconds, progressSeconds));
    }
  };
}

async function createSegmentVideo({
  imagePath,
  durationSeconds,
  outputPath,
  onProgress = () => {},
}) {
  const duration = Math.max(0.2, Number(durationSeconds || 0));
  const result = await runCommandStream(
    "ffmpeg",
    [
      "-y",
      "-loop",
      "1",
      "-i",
      imagePath,
      "-t",
      String(duration),
      "-r",
      "30",
      "-vf",
      "scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=black",
      "-pix_fmt",
      "yuv420p",
      "-progress",
      "pipe:2",
      "-nostats",
      outputPath,
    ],
    {
      onStderr: makeFfmpegProgressParser({
        durationSeconds: duration,
        onSeconds: onProgress,
      }),
    },
  );

  onProgress(duration);

  if (result.status !== 0) {
    throw new Error(
      `ffmpeg failed to create segment video: ${result.stderr || result.stdout}`,
    );
  }
}

async function createStaticClipVideo({
  imagePath,
  durationSeconds,
  outputPath,
  overlay,
  subtitlesFile,
  fontsDir,
  signal,
  onProgress = () => {},
}) {
  const duration = Math.max(0.2, Number(durationSeconds || 0));
  // Streamed (async) spawn keeps the UI server's event loop free while ffmpeg runs.
  const result = await runCommandStream(
    "ffmpeg",
    [
      "-y",
      "-loop",
      "1",
      "-i",
      imagePath,
      "-t",
      String(duration),
      "-r",
      "30",
      "-filter_complex",
      buildClipVisualFilter({
        overlay,
        subtitlesFile,
        fontsDir,
        progressBarDurationSeconds: duration,
      }),
      "-map",
      "[vout]",
      "-pix_fmt",
      "yuv420p",
      "-progress",
      "pipe:2",
      "-nostats",
      outputPath,
    ],
    {
      signal,
      onStderr: makeFfmpegProgressParser({
        durationSeconds: duration,
        onSeconds: onProgress,
      }),
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `ffmpeg failed to create clip video: ${result.stderr || result.stdout}`,
    );
  }
}

async function createClipVideoWithAudio({
  imagePath,
  mp3Path,
  startSeconds,
  durationSeconds,
  outputPath,
  overlay,
  subtitlesFile,
  fontsDir,
  signal,
  onProgress = () => {},
}) {
  const duration = Math.max(0.2, Number(durationSeconds || 0));
  const start = Math.max(0, Number(startSeconds || 0));

  const args = (filterGraph) => [
    "-y",
    "-loop",
    "1",
    "-i",
    imagePath,
    "-ss",
    String(start),
    "-t",
    String(duration),
    "-i",
    mp3Path,
    "-map",
    "1:a:0",
    "-map_chapters",
    "-1",
    "-map_metadata",
    "-1",
    "-sn",
    "-dn",
    "-r",
    "30",
    "-filter_complex",
    filterGraph,
    "-map",
    "[vout]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-shortest",
    "-progress",
    "pipe:2",
    "-nostats",
    outputPath,
  ];

  // Streamed (async) spawn keeps the UI server's event loop free while ffmpeg runs.
  const result = await runCommandStream(
    "ffmpeg",
    args(
      buildClipVisualFilter({
        overlay,
        subtitlesFile,
        fontsDir,
        progressBarDurationSeconds: duration,
      }),
    ),
    {
      signal,
      onStderr: makeFfmpegProgressParser({
        durationSeconds: duration,
        onSeconds: onProgress,
      }),
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `ffmpeg failed to create clip video: ${result.stderr || result.stdout}`,
    );
  }
}

async function generateVideoFromChapters({
  chapters,
  mp3Path,
  outputPath,
  workDir,
  onProgress = () => {},
}) {
  ensureDir(workDir);
  ensureDir(path.dirname(outputPath));

  const segmentWeight = 0.9;
  const concatWeight = 0.05;
  const muxWeight = 0.05;
  const startedAtMs = Date.now();
  const totalDurationSeconds = Math.max(
    1,
    chapters.reduce(
      (sum, chapter) => sum + Math.max(0, Number(chapter.durationSeconds || 0)),
      0,
    ),
  );
  let completedDurationSeconds = 0;

  function clampPercent(value) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function estimateEtaSeconds(percent) {
    const normalizedPercent = Number(percent);
    if (!Number.isFinite(normalizedPercent) || normalizedPercent <= 0) {
      return null;
    }
    const elapsedSeconds = (Date.now() - startedAtMs) / 1000;
    if (elapsedSeconds <= 0) {
      return null;
    }
    const estimatedTotalSeconds = elapsedSeconds / (normalizedPercent / 100);
    const remaining = Math.max(0, estimatedTotalSeconds - elapsedSeconds);
    return Math.round(remaining);
  }

  const segmentPaths = [];

  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = chapters[index];
    const chapterDurationSeconds = Math.max(
      0,
      Number(chapter.durationSeconds || 0),
    );
    const completedDurationBeforeChapter = completedDurationSeconds;
    const segmentPath = path.join(
      workDir,
      `segment-${String(index + 1).padStart(3, "0")}.mp4`,
    );
    await createSegmentVideo({
      imagePath: chapter.imagePath,
      durationSeconds: chapterDurationSeconds,
      outputPath: segmentPath,
      onProgress: (chapterRenderedSeconds) => {
        const effectiveRenderedSeconds = Math.max(
          0,
          Math.min(chapterDurationSeconds, Number(chapterRenderedSeconds || 0)),
        );
        const progressDurationSeconds =
          completedDurationBeforeChapter + effectiveRenderedSeconds;
        const segmentProgressRatio = Math.max(
          0,
          Math.min(1, progressDurationSeconds / totalDurationSeconds),
        );
        const percent = clampPercent(
          segmentProgressRatio * segmentWeight * 100,
        );

        onProgress({
          phase: "segments",
          current: index + 1,
          total: chapters.length,
          chapterTitle: chapter.title,
          chapterDurationSeconds,
          completedDurationSeconds: progressDurationSeconds,
          totalDurationSeconds,
          percent,
          etaSeconds: estimateEtaSeconds(percent),
        });
      },
    });
    segmentPaths.push(segmentPath);

    completedDurationSeconds += chapterDurationSeconds;
  }

  const concatListPath = path.join(workDir, "segments.txt");
  const concatText = segmentPaths
    .map((segmentPath) => `file '${segmentPath.replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(concatListPath, `${concatText}\n`, "utf8");

  const videoOnlyPath = path.join(workDir, "video-only.mp4");
  const concatResult = await runCommandStream("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatListPath,
    "-c",
    "copy",
    videoOnlyPath,
  ]);

  if (concatResult.status !== 0) {
    throw new Error(
      `ffmpeg failed while concatenating chapter segments: ${concatResult.stderr || concatResult.stdout}`,
    );
  }

  const concatPercent = clampPercent((segmentWeight + concatWeight) * 100);
  onProgress({
    phase: "concat",
    completedDurationSeconds,
    totalDurationSeconds,
    percent: concatPercent,
    etaSeconds: estimateEtaSeconds(concatPercent),
  });

  const muxResult = await runCommandStream("ffmpeg", [
    "-y",
    "-i",
    videoOnlyPath,
    "-i",
    mp3Path,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-shortest",
    outputPath,
  ]);

  if (muxResult.status !== 0) {
    throw new Error(
      `ffmpeg failed while combining video and audio: ${muxResult.stderr || muxResult.stdout}`,
    );
  }

  const muxPercent = clampPercent(
    (segmentWeight + concatWeight + muxWeight) * 100,
  );
  onProgress({
    phase: "mux",
    completedDurationSeconds,
    totalDurationSeconds,
    percent: muxPercent,
    etaSeconds: 0,
  });

  return outputPath;
}

function clipCancelledError() {
  const error = new Error("Clip generation cancelled");
  error.name = "AbortError";
  return error;
}

async function generateClipVideos({
  clipSuggestions,
  imagePath,
  mp3Path,
  outputDir,
  workDir,
  episodeTitle,
  episodeDateString,
  transcriptVttText,
  startIndex = 0,
  signal,
  onProgress = () => {},
}) {
  if (!Array.isArray(clipSuggestions) || clipSuggestions.length === 0) {
    return [];
  }

  const cues = transcriptVttText ? parseVttCues(transcriptVttText) : [];

  // Checked once up front so a build that cannot draw text fails before rendering
  // anything, instead of quietly producing clips with no label or subtitles on them.
  assertFfmpegFilters(
    cues.length > 0 ? ["drawtext", "subtitles"] : ["drawtext"],
  );

  ensureDir(outputDir);
  ensureDir(workDir);

  const overlay = prepareEpisodeOverlay({
    episodeTitle,
    episodeDateString,
    workDir,
  });
  // libass loads the subtitle face from this directory rather than via fontconfig.
  const fontsDir = path.dirname(resolveClipBoldFontPath());

  const outputs = [];
  const totalSteps = Math.max(1, clipSuggestions.length);
  const indexOffset = Math.max(0, Number(startIndex || 0));

  // Clip durations vary a lot (roughly 28-55s) and encode time tracks output duration,
  // so percent is weighted by rendered seconds - including mid-render progress from
  // ffmpeg - rather than by clip count.
  const clipDurations = clipSuggestions.map((clipSuggestion) =>
    Math.max(2, Number(clipSuggestion?.durationSeconds || 12)),
  );
  const totalDurationSeconds = clipDurations.reduce((sum, d) => sum + d, 0);
  let completedDurationSeconds = 0;

  const reportProgress = (clipsDone, midClipSeconds) => {
    const doneSeconds = Math.min(
      totalDurationSeconds,
      completedDurationSeconds + Math.max(0, midClipSeconds),
    );
    onProgress({
      current: clipsDone,
      total: totalSteps,
      percent:
        totalDurationSeconds > 0
          ? Math.round((doneSeconds / totalDurationSeconds) * 100)
          : 0,
    });
  };

  for (let index = 0; index < clipSuggestions.length; index += 1) {
    const clipSuggestion = clipSuggestions[index];
    const absoluteIndex = indexOffset + index;
    const durationSeconds = clipDurations[index];
    const startSeconds = Math.max(0, Number(clipSuggestion?.startSeconds || 0));
    const outputPath = path.join(
      outputDir,
      buildClipVideoOutputName({ index: absoluteIndex, clipSuggestion }),
    );
    const onRenderProgress = (seconds) => reportProgress(index, seconds);

    const subtitlesFile = writeClipSubtitles({
      cues: sliceCuesForClip({
        cues,
        clipStartSeconds: startSeconds,
        clipEndSeconds: startSeconds + durationSeconds,
        excludedCueStarts: Array.isArray(clipSuggestion?.excludedCueStarts)
          ? clipSuggestion.excludedCueStarts
          : [],
      }),
      workDir,
      name: `subs-${String(absoluteIndex + 1).padStart(3, "0")}`,
    });

    if (signal?.aborted) {
      throw clipCancelledError();
    }

    try {
      if (mp3Path) {
        await createClipVideoWithAudio({
          imagePath,
          mp3Path,
          startSeconds,
          durationSeconds,
          outputPath,
          overlay,
          subtitlesFile,
          fontsDir,
          signal,
          onProgress: onRenderProgress,
        });
      } else {
        await createStaticClipVideo({
          imagePath,
          durationSeconds,
          outputPath,
          overlay,
          subtitlesFile,
          fontsDir,
          signal,
          onProgress: onRenderProgress,
        });
      }
    } catch (error) {
      // Aborting kills ffmpeg mid-write; remove the truncated file so a cancelled run
      // never leaves an unplayable clip lying next to the finished ones.
      if (signal?.aborted) {
        fs.rmSync(outputPath, { force: true });
        throw clipCancelledError();
      }
      throw error;
    }

    const summary =
      clipSuggestion?.summary ||
      clipSuggestion?.title ||
      `Clip ${absoluteIndex + 1}`;
    outputs.push({
      title: clipSuggestion?.title || summary,
      summary,
      caption: clipSuggestion?.caption || "",
      outputPath,
      durationSeconds,
      startSeconds,
      endSeconds: clipSuggestion?.endSeconds,
    });

    completedDurationSeconds += durationSeconds;
    reportProgress(index + 1, 0);
  }

  writeClipCaptionsFile({ outputDir, outputs });

  return outputs;
}

// One paste-ready caption per rendered clip, next to the clips themselves. AI picks
// carry a caption from the model; heuristic picks fall back to their summary so the
// file is complete either way. Rewritten per generation run.
function writeClipCaptionsFile({ outputDir, outputs }) {
  const blocks = outputs
    .map((output) => {
      const caption = output.caption || output.summary || output.title;
      return caption
        ? `${path.basename(output.outputPath)}\n${ensureRequiredHashtags(caption)}\n`
        : null;
    })
    .filter(Boolean);

  if (blocks.length === 0) {
    return;
  }
  fs.writeFileSync(path.join(outputDir, "captions.txt"), blocks.join("\n"));
}

module.exports = {
  buildClipVideoOutputName,
  buildClipVisualFilter,
  generateClipVideos,
  generateVideoFromChapters,
};
