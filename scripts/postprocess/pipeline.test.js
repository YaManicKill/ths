const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { discoverEpisodeData, runPipeline } = require("./pipeline");
const { runCommand } = require("./utils");

// Discovery needs a real MP3 with chapters, so build a tiny one with ffmpeg.
function makeEpisodeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ths-pipeline-"));
  const metadataPath = path.join(dir, "meta.txt");
  fs.writeFileSync(
    metadataPath,
    [
      ";FFMETADATA1",
      "title=Test Episode",
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      "START=0",
      "END=30000",
      "title=Intro",
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      "START=30000",
      "END=60000",
      "title=Stardew Valley",
      "",
    ].join("\n"),
  );

  const mp3Path = path.join(dir, "ths-99-01.mp3");
  const built = runCommand("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=60",
    "-i",
    metadataPath,
    "-map_metadata",
    "1",
    mp3Path,
  ]);
  assert.equal(built.status, 0, `ffmpeg fixture failed: ${built.stderr}`);

  const transcriptMdPath = path.join(dir, "Test Episode.md");
  fs.writeFileSync(
    transcriptMdPath,
    [
      "## Chat",
      "",
      "**Al:** (0h0m40s)",
      "",
      "Why would anyone actually do that, honestly?",
      "",
    ].join("\n"),
  );

  const transcriptVttPath = path.join(dir, "Test Episode.vtt");
  fs.writeFileSync(
    transcriptVttPath,
    [
      "WEBVTT",
      "",
      "00:00:40.000 --> 00:00:45.000",
      "Why would anyone do that?",
      "",
      "00:00:45.000 --> 00:01:05.000",
      "Al: Because it seemed like a good idea at the time, and everyone agreed with me.",
      "",
      "00:01:05.000 --> 00:01:12.000",
      "Al: That was the whole story from start to finish.",
      "",
    ].join("\n"),
  );

  return { mp3Path, transcriptMdPath, transcriptVttPath };
}

const fixture = makeEpisodeFixture();
const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ths-repo-"));
const workRoot = path.join(repoRoot, ".cache", "postprocess");
fs.mkdirSync(workRoot, { recursive: true });

const stale = Date.now() - 48 * 60 * 60 * 1000;
const recent = Date.now() - 60 * 1000;

// manual-images holds the chapter images that saved overrides point at, so pruning must
// never touch it, and neither should it touch dirs it does not recognise.
const seeded = {
  [`ths-11-22-${stale}`]: false,
  [`rerender-${stale}`]: false,
  [`ths-11-19-${recent}`]: true,
  "manual-images": true,
  "image-cache": true,
  "something-else": true,
};

for (const name of Object.keys(seeded)) {
  fs.mkdirSync(path.join(workRoot, name), { recursive: true });
  fs.writeFileSync(path.join(workRoot, name, "file.bin"), "x");
}

function initGitRepo(root) {
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
  ]) {
    const result = runCommand("git", args, { cwd: root });
    assert.equal(result.status, 0, `git ${args[0]} failed: ${result.stderr}`);
  }
  fs.writeFileSync(path.join(root, ".keep"), "x");
  runCommand("git", ["add", "-A"], { cwd: root });
  const committed = runCommand("git", ["commit", "-qm", "init"], { cwd: root });
  assert.equal(committed.status, 0, `git commit failed: ${committed.stderr}`);
}

async function main() {
  const discovered = await discoverEpisodeData({
    repoRoot,
    mp3Path: fixture.mp3Path,
    transcriptMdPath: fixture.transcriptMdPath,
    transcriptVttPath: fixture.transcriptVttPath,
    onProgress: () => {},
  });

  assert.equal(discovered.episodeMeta.guid, "ths-99-01");
  assert.ok(discovered.chapters.length >= 2, "expected chapters from the MP3");

  const survivors = fs.readdirSync(workRoot);
  for (const [name, shouldRemain] of Object.entries(seeded)) {
    assert.equal(
      survivors.includes(name),
      shouldRemain,
      `${name} should ${shouldRemain ? "have survived" : "have been pruned"}`,
    );
  }

  assert.ok(
    survivors.some((name) => /^ths-99-01-\d+$/.test(name)),
    "the current run's own work dir was pruned",
  );

  // A full run, so the saved report can be inspected. The MP3 is copied first because the
  // run embeds chapter images into it.
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ths-run-"));
  initGitRepo(runRoot);
  const runMp3 = path.join(runRoot, "ths-99-01.mp3");
  fs.copyFileSync(fixture.mp3Path, runMp3);

  // The AI transcript check and clip selection both run during generation; the fake
  // completer stands in for Gemini, answering by request schema, so both paths run
  // without a network call.
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-key";
  const fakeClips = {
    clips: [
      {
        openingQuote: "Because it seemed like a good idea at the time",
        closingQuote: "the whole story from start to finish",
        title: "A good idea at the time",
        category: "story",
        reason: "test",
        score: 75,
      },
    ],
  };
  const { report } = await runPipeline({
    repoRoot: runRoot,
    mp3Path: runMp3,
    transcriptMdPath: fixture.transcriptMdPath,
    transcriptVttPath: fixture.transcriptVttPath,
    skipVideo: true,
    onProgress: () => {},
    llmComplete: async ({ schema }) =>
      schema?.properties?.clips
        ? fakeClips
        : {
            findings: [
              {
                quote: "Why would anyone",
                correction: "Why would somebody",
                reason: "test",
                confidence: "high",
              },
              // Present in the md fixture but not the vtt one, so it must be reported
              // as missed there rather than silently dropped.
              {
                quote: "actually do that",
                correction: "genuinely do that",
                reason: "test",
                confidence: "high",
              },
              {
                quote: "honestly",
                correction: "frankly",
                reason: "test",
                confidence: "medium",
              },
            ],
          },
  });

  assert.equal(report.gitBranch.name, "ep-99-01");
  assert.ok(
    report.mp3ChapterImages.completed,
    "chapter images were not embedded",
  );

  const episodeDir = path.dirname(
    path.join(report.episode.outputDirectory, "index.md"),
  );

  assert.equal(report.transcriptReview.enabled, true);
  assert.equal(report.transcriptReview.findings.length, 3);

  // High-confidence review findings are applied to the written transcripts; medium
  // ones are not (they need an explicit transcriptFixes list from the UI).
  const writtenMd = fs.readFileSync(
    path.join(episodeDir, "transcript.md"),
    "utf8",
  );
  const writtenVtt = fs.readFileSync(
    path.join(episodeDir, "transcript.vtt"),
    "utf8",
  );
  assert.ok(writtenMd.includes("Why would somebody genuinely do that"));
  assert.ok(writtenMd.includes("honestly"), "medium fix must not auto-apply");
  assert.ok(writtenVtt.includes("Why would somebody do that?"));
  assert.deepEqual(report.transcriptFixes, {
    attempted: 2,
    mdApplied: 2,
    vttApplied: 1,
    mdMissed: [],
    vttMissed: ["actually do that"],
  });

  // The AI clip picks replace the heuristic suggestions, grounded in the VTT timings.
  assert.equal(report.clipSource, "llm");
  assert.equal(report.clipSuggestions.length, 1);
  assert.equal(report.clipSuggestions[0].startSeconds, 45);
  assert.equal(report.clipSuggestions[0].endSeconds, 72);
  assert.equal(report.clipSuggestions[0].summary, "A good idea at the time");
  assert.equal(report.clipSuggestions[0].speaker, "Al");
  const savedReport = JSON.parse(
    fs.readFileSync(path.join(episodeDir, "postprocess-report.json"), "utf8"),
  );

  // The report is written after the video branch runs, so videoStatus must be present.
  assert.ok(
    savedReport.videoStatus,
    "postprocess-report.json is missing videoStatus",
  );
  assert.equal(savedReport.videoStatus.skipped, true);

  fs.rmSync(repoRoot, { recursive: true, force: true });
  fs.rmSync(runRoot, { recursive: true, force: true });
  console.log("pipeline test passed", { survivors: survivors.length });
}

main().catch((error) => {
  console.error("pipeline test failed:", error.message);
  process.exit(1);
});
