const fs = require("node:fs");
const path = require("node:path");
const { ensureDir, runCommand } = require("./utils");

function createSegmentVideo({ imagePath, durationSeconds, outputPath }) {
  const duration = Math.max(0.2, Number(durationSeconds || 0));
  const result = runCommand("ffmpeg", [
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
    outputPath,
  ]);

  if (result.status !== 0) {
    throw new Error(
      `ffmpeg failed to create segment video: ${result.stderr || result.stdout}`,
    );
  }
}

function generateVideoFromChapters({
  chapters,
  mp3Path,
  outputPath,
  workDir,
  onProgress = () => {},
}) {
  ensureDir(workDir);
  ensureDir(path.dirname(outputPath));

  const segmentPaths = [];
  const totalSteps = Math.max(1, chapters.length + 2); // segments + concat + mux
  let completedSteps = 0;

  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = chapters[index];
    const segmentPath = path.join(
      workDir,
      `segment-${String(index + 1).padStart(3, "0")}.mp4`,
    );
    createSegmentVideo({
      imagePath: chapter.imagePath,
      durationSeconds: chapter.durationSeconds,
      outputPath: segmentPath,
    });
    segmentPaths.push(segmentPath);
    completedSteps += 1;
    onProgress({
      phase: "segments",
      current: index + 1,
      total: chapters.length,
      percent: Math.round((completedSteps / totalSteps) * 100),
    });
  }

  const concatListPath = path.join(workDir, "segments.txt");
  const concatText = segmentPaths
    .map((segmentPath) => `file '${segmentPath.replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(concatListPath, `${concatText}\n`, "utf8");

  const videoOnlyPath = path.join(workDir, "video-only.mp4");
  const concatResult = runCommand("ffmpeg", [
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

  completedSteps += 1;
  onProgress({
    phase: "concat",
    percent: Math.round((completedSteps / totalSteps) * 100),
  });

  const muxResult = runCommand("ffmpeg", [
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

  completedSteps += 1;
  onProgress({
    phase: "mux",
    percent: Math.round((completedSteps / totalSteps) * 100),
  });

  return outputPath;
}

module.exports = {
  generateVideoFromChapters,
};
