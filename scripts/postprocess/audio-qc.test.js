const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  analyzeAudio,
  analyzeAudioCached,
  buildAudioQcWarnings,
  parseEbur128Summary,
  parseSilences,
} = require("./audio-qc");
const { runCommand } = require("./utils");

// Parsers against canned ffmpeg stderr: the summary is read from the final Summary
// block, not the per-100ms progress lines that also contain "I: ... LUFS".
const cannedStderr = [
  "[Parsed_ebur128_0 @ 0x1] t: 0.1 TARGET:-23 LUFS M:-120.7 S:-120.7 I: -70.0 LUFS LRA: 0.0 LU",
  "[silencedetect @ 0x2] silence_start: 120.5",
  "[silencedetect @ 0x2] silence_end: 128.25 | silence_duration: 7.75",
  "[Parsed_ebur128_0 @ 0x1] Summary:",
  "",
  "  Integrated loudness:",
  "    I:         -16.2 LUFS",
  "    Threshold: -26.9 LUFS",
  "",
  "  Loudness range:",
  "    LRA:        6.4 LU",
  "",
  "  True peak:",
  "    Peak:      -0.8 dBFS",
].join("\n");

assert.deepEqual(parseEbur128Summary(cannedStderr), {
  integratedLufs: -16.2,
  loudnessRange: 6.4,
  truePeakDb: -0.8,
});
assert.deepEqual(parseSilences(cannedStderr), [
  { startSeconds: 120.5, endSeconds: 128.25, durationSeconds: 7.75 },
]);

// Warnings: loudness within tolerance passes, peak above the ceiling and silences warn.
const warnings = buildAudioQcWarnings({
  integratedLufs: -16.2,
  truePeakDb: -0.8,
  silences: [
    { startSeconds: 120.5, endSeconds: 128.25, durationSeconds: 7.75 },
  ],
});
assert.equal(warnings.length, 2);
assert.match(warnings[0], /True peak -0\.8/);
assert.match(warnings[1], /8s of silence at 00:02:00/);

assert.deepEqual(
  buildAudioQcWarnings({
    integratedLufs: -16.5,
    truePeakDb: -1.4,
    silences: [],
  }),
  [],
  "in-spec audio must produce no warnings",
);

async function main() {
  // Real analysis on a fixture: 4s of loud tone, 6s of silence, 4s of tone. The 6s gap
  // must be detected, and the loud tone puts integrated loudness off target.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ths-audio-qc-"));
  const mp3Path = path.join(dir, "fixture.mp3");
  const built = runCommand("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=4",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=duration=6",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:duration=4",
    "-filter_complex",
    "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
    "-map",
    "[out]",
    mp3Path,
  ]);
  assert.equal(built.status, 0, `fixture ffmpeg failed: ${built.stderr}`);

  const analysis = await analyzeAudio({ mp3Path });
  assert.ok(
    typeof analysis.integratedLufs === "number",
    "integrated loudness missing",
  );
  assert.equal(analysis.silences.length, 1, "the 6s gap was not detected");
  assert.ok(
    Math.abs(analysis.silences[0].durationSeconds - 6) < 1,
    `silence duration off: ${analysis.silences[0].durationSeconds}`,
  );

  // Cache: same file is a hit; touching the file re-runs.
  const cacheDir = path.join(dir, "cache");
  let calls = 0;
  const countingAnalyze = async (options) => {
    calls += 1;
    return analyzeAudio(options);
  };

  const first = await analyzeAudioCached({
    cacheDir,
    mp3Path,
    analyze: countingAnalyze,
  });
  assert.equal(first.fromCache, false);
  const second = await analyzeAudioCached({
    cacheDir,
    mp3Path,
    analyze: countingAnalyze,
  });
  assert.equal(second.fromCache, true);
  assert.equal(calls, 1, "cached analysis must not re-run");

  const future = new Date(Date.now() + 5000);
  fs.utimesSync(mp3Path, future, future);
  await analyzeAudioCached({ cacheDir, mp3Path, analyze: countingAnalyze });
  assert.equal(calls, 2, "modified file must re-run");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("audio-qc test passed");
}

main().catch((error) => {
  console.error("audio-qc test failed:", error.message);
  process.exit(1);
});
