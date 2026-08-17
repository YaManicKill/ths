const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { formatSecondsToHhmmss } = require("./parsers");
const {
  fileExists,
  readJson,
  runCommandStream,
  writeJson,
} = require("./utils");

// Bump when the filters or thresholds change so cached analyses are not reused.
const AUDIO_QC_VERSION = 1;

// -16 LUFS is the common podcast loudness target; a couple of LU either way is fine.
const TARGET_LUFS = -16;
const LOUDNESS_TOLERANCE_LU = 2;
// True peaks above -1 dBTP risk clipping after lossy encoding.
const TRUE_PEAK_MAX_DB = -1;
const SILENCE_NOISE_FLOOR = "-50dB";
const SILENCE_MIN_SECONDS = 5;
const MAX_SILENCES_REPORTED = 5;

function parseEbur128Summary(stderrText) {
  const text = String(stderrText || "");
  const tail = text.slice(Math.max(0, text.lastIndexOf("Summary:")));
  const num = (pattern) => {
    const match = pattern.exec(tail);
    return match ? Number(match[1]) : null;
  };
  return {
    integratedLufs: num(/I:\s*(-?[\d.]+) LUFS/),
    loudnessRange: num(/LRA:\s*(-?[\d.]+) LU/),
    truePeakDb: num(/Peak:\s*(-?[\d.]+) dBFS/),
  };
}

function parseSilences(stderrText) {
  const text = String(stderrText || "");
  const silences = [];
  const pattern =
    /silence_end:\s*(-?[\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const endSeconds = Number(match[1]);
    const durationSeconds = Number(match[2]);
    silences.push({
      startSeconds: Math.max(0, endSeconds - durationSeconds),
      endSeconds,
      durationSeconds,
    });
  }
  return silences;
}

async function analyzeAudio({ mp3Path }) {
  // Explicit audio-only mapping: episode MP3s carry an attached-picture video stream
  // (the embedded chapter images), and default stream selection with a null muxer
  // exits after its single frame - reporting dead silence for the whole episode.
  const result = await runCommandStream("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    mp3Path,
    "-map",
    "0:a:0",
    "-af",
    `ebur128=peak=true,silencedetect=noise=${SILENCE_NOISE_FLOOR}:duration=${SILENCE_MIN_SECONDS}`,
    "-f",
    "null",
    "-",
  ]);
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg audio analysis failed: ${result.stderr.slice(-300)}`,
    );
  }

  return {
    ...parseEbur128Summary(result.stderr),
    silences: parseSilences(result.stderr),
  };
}

function buildAudioQcWarnings(analysis) {
  const warnings = [];

  if (
    analysis.integratedLufs !== null &&
    Math.abs(analysis.integratedLufs - TARGET_LUFS) > LOUDNESS_TOLERANCE_LU
  ) {
    warnings.push(
      `Integrated loudness ${analysis.integratedLufs} LUFS is off the ${TARGET_LUFS} LUFS podcast target`,
    );
  }

  if (analysis.truePeakDb !== null && analysis.truePeakDb > TRUE_PEAK_MAX_DB) {
    warnings.push(
      `True peak ${analysis.truePeakDb} dBFS risks clipping (keep at or below ${TRUE_PEAK_MAX_DB})`,
    );
  }

  const silences = analysis.silences || [];
  for (const silence of silences.slice(0, MAX_SILENCES_REPORTED)) {
    warnings.push(
      `${Math.round(silence.durationSeconds)}s of silence at ${formatSecondsToHhmmss(silence.startSeconds)}`,
    );
  }
  if (silences.length > MAX_SILENCES_REPORTED) {
    warnings.push(
      `...and ${silences.length - MAX_SILENCES_REPORTED} more silence(s)`,
    );
  }

  return warnings;
}

// The analysis decodes the entire episode, so it is cached by the MP3's identity
// (path, size, mtime) - discovery re-runs cost nothing until the file changes.
async function analyzeAudioCached({
  cacheDir,
  mp3Path,
  analyze = analyzeAudio,
}) {
  const stat = fs.statSync(mp3Path);
  const cacheKey = crypto
    .createHash("sha1")
    .update(`${AUDIO_QC_VERSION}:${mp3Path}:${stat.size}:${stat.mtimeMs}`)
    .digest("hex");
  const cachePath = cacheDir ? path.join(cacheDir, `${cacheKey}.json`) : null;

  if (cachePath && fileExists(cachePath)) {
    const cached = readJson(cachePath, false);
    if (cached) {
      return { ...cached, fromCache: true };
    }
  }

  const result = await analyze({ mp3Path });
  if (cachePath) {
    writeJson(cachePath, result);
  }
  return { ...result, fromCache: false };
}

module.exports = {
  analyzeAudio,
  analyzeAudioCached,
  buildAudioQcWarnings,
  parseEbur128Summary,
  parseSilences,
};
