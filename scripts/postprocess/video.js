const fs = require("node:fs");
const path = require("node:path");
const { ensureDir, runCommandStream } = require("./utils");

const CLIP_WIDTH = 1080;
const CLIP_HEIGHT = 1920;

function buildClipVisualFilter({ withLabel = false, label = "Clip" } = {}) {
  const labelY = Math.floor(CLIP_HEIGHT * 0.8);

  let graph =
    `[0:v]scale=${CLIP_WIDTH}:${CLIP_HEIGHT}:force_original_aspect_ratio=increase,crop=${CLIP_WIDTH}:${CLIP_HEIGHT},boxblur=34:10,eq=saturation=1.12:brightness=-0.05[bg];` +
    `[0:v]scale=${CLIP_WIDTH}:-2:flags=lanczos[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2`;

  if (withLabel) {
    graph += `,drawtext=text='${escapeFfmpegText(label)}':fontcolor=white:fontsize=52:fontfile=/System/Library/Fonts/Helvetica.ttc:box=1:boxcolor=black@0.35:boxborderw=18:x=(w-text_w)/2:y=${labelY}`;
  }

  return `${graph}[vout]`;
}

function escapeFfmpegText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
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

async function createSegmentVideo({
  imagePath,
  durationSeconds,
  outputPath,
  onProgress = () => {},
}) {
  const duration = Math.max(0.2, Number(durationSeconds || 0));
  let stderrBuffer = "";
  let lastProgressSeconds = 0;
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
      onStderr: (chunk) => {
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
          onProgress(Math.min(duration, progressSeconds));
        }
      },
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
  label,
}) {
  const duration = Math.max(0.2, Number(durationSeconds || 0));
  const visualWithLabel = buildClipVisualFilter({
    withLabel: true,
    label: label || "Clip",
  });
  // Streamed (async) spawn keeps the UI server's event loop free while ffmpeg runs.
  const result = await runCommandStream("ffmpeg", [
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
    visualWithLabel,
    "-map",
    "[vout]",
    "-pix_fmt",
    "yuv420p",
    outputPath,
  ]);

  if (result.status === 0) {
    return;
  }

  const drawtextMissing = /No such filter:\s*'drawtext'/i.test(
    `${result.stderr || ""}\n${result.stdout || ""}`,
  );

  if (drawtextMissing) {
    // Some ffmpeg builds exclude drawtext (libfreetype). Fall back to image-only clips.
    const visualNoLabel = buildClipVisualFilter({ withLabel: false });
    const fallbackResult = await runCommandStream("ffmpeg", [
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
      visualNoLabel,
      "-map",
      "[vout]",
      "-pix_fmt",
      "yuv420p",
      outputPath,
    ]);

    if (fallbackResult.status === 0) {
      return;
    }

    throw new Error(
      `ffmpeg failed to create clip video: ${fallbackResult.stderr || fallbackResult.stdout}`,
    );
  }

  throw new Error(
    `ffmpeg failed to create clip video: ${result.stderr || result.stdout}`,
  );
}

async function createClipVideoWithAudio({
  imagePath,
  mp3Path,
  startSeconds,
  durationSeconds,
  outputPath,
  label,
}) {
  const duration = Math.max(0.2, Number(durationSeconds || 0));
  const start = Math.max(0, Number(startSeconds || 0));
  const visualWithLabel = buildClipVisualFilter({
    withLabel: true,
    label: label || "Clip",
  });
  const visualNoLabel = buildClipVisualFilter({ withLabel: false });

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
    outputPath,
  ];

  // Streamed (async) spawn keeps the UI server's event loop free while ffmpeg runs.
  const result = await runCommandStream("ffmpeg", args(visualWithLabel));
  if (result.status === 0) {
    return;
  }

  const drawtextMissing = /No such filter:\s*'drawtext'/i.test(
    `${result.stderr || ""}\n${result.stdout || ""}`,
  );

  if (drawtextMissing) {
    const fallbackResult = await runCommandStream(
      "ffmpeg",
      args(visualNoLabel),
    );
    if (fallbackResult.status === 0) {
      return;
    }

    throw new Error(
      `ffmpeg failed to create clip video: ${fallbackResult.stderr || fallbackResult.stdout}`,
    );
  }

  throw new Error(
    `ffmpeg failed to create clip video: ${result.stderr || result.stdout}`,
  );
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

async function generateClipVideos({
  clipSuggestions,
  imagePath,
  mp3Path,
  outputDir,
  workDir,
  startIndex = 0,
  onProgress = () => {},
}) {
  if (!Array.isArray(clipSuggestions) || clipSuggestions.length === 0) {
    return [];
  }

  ensureDir(outputDir);
  ensureDir(workDir);

  const outputs = [];
  const totalSteps = Math.max(1, clipSuggestions.length);
  const indexOffset = Math.max(0, Number(startIndex || 0));

  for (let index = 0; index < clipSuggestions.length; index += 1) {
    const clipSuggestion = clipSuggestions[index];
    const absoluteIndex = indexOffset + index;
    const durationSeconds = Math.max(
      2,
      Number(clipSuggestion?.durationSeconds || 12),
    );
    const label =
      clipSuggestion?.summary ||
      clipSuggestion?.title ||
      `Clip ${absoluteIndex + 1}`;
    const startSeconds = Math.max(0, Number(clipSuggestion?.startSeconds || 0));
    const outputPath = path.join(
      outputDir,
      buildClipVideoOutputName({ index: absoluteIndex, clipSuggestion }),
    );

    if (mp3Path) {
      await createClipVideoWithAudio({
        imagePath,
        mp3Path,
        startSeconds,
        durationSeconds,
        outputPath,
        label,
      });
    } else {
      await createStaticClipVideo({
        imagePath,
        durationSeconds,
        outputPath,
        label,
      });
    }

    outputs.push({
      title: clipSuggestion?.title || label,
      summary: label,
      outputPath,
      durationSeconds,
      startSeconds,
      endSeconds: clipSuggestion?.endSeconds,
    });

    onProgress({
      current: index + 1,
      total: totalSteps,
      percent: Math.round(((index + 1) / totalSteps) * 100),
    });
  }

  return outputs;
}

module.exports = {
  buildClipVideoOutputName,
  generateClipVideos,
  generateVideoFromChapters,
};
