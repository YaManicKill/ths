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
      // The recording tool's placeholder: the run must replace it with the real
      // episode title when it embeds the chapter images.
      "title=THS 99-01",
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      "START=0",
      "END=30000",
      "title=Intro",
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      "START=30000",
      "END=45000",
      "title=Stardew Valley",
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      "START=45000",
      "END=60000",
      "title=Secret Game",
      "TOC=false",
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

// The run returns before its LLM work: tests wait for the background job to settle
// before asserting on its output (and before cleaning up under its feet).
async function waitForAiAnalysis(episodeDir) {
  for (let i = 0; i < 400; i += 1) {
    const state = JSON.parse(
      fs.readFileSync(path.join(episodeDir, "postprocess-state.json"), "utf8"),
    );
    const status = state.jobs?.aiAnalysis?.status;
    if (status === "completed" || status === "failed") {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("AI analysis did not finish in time");
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
    shownotesLinks: [
      { title: "Cool Bug", url: "https://example.com/bug" },
      { title: "A Game With No Steam Page", url: "" },
    ],
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

  // The embed step also syncs the ID3 title: the fixture MP3 carried the recording
  // tool's "THS 99-01" placeholder, the episode is titled from the transcript file.
  const taggedTitle = runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format_tags=title",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    runMp3,
  ]);
  assert.equal(
    taggedTitle.stdout.trim(),
    "Test Episode",
    "the MP3 title tag must follow the chosen episode title",
  );

  const episodeDir = path.dirname(
    path.join(report.episode.outputDirectory, "index.md"),
  );

  // The LLM work happens after the run returns: the response only marks it pending,
  // and the job in the state file is what settles.
  assert.equal(report.transcriptReview.enabled, true);
  assert.equal(report.transcriptReview.pending, true);
  assert.equal(report.aiAnalysis.started, true);
  const analyzedState = await waitForAiAnalysis(episodeDir);
  assert.equal(analyzedState.jobs.aiAnalysis.status, "completed");
  assert.equal(analyzedState.transcriptReview.findings.length, 3);

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
  assert.deepEqual(
    analyzedState.appliedTranscriptFixes.map((fix) => fix.correction),
    ["Why would somebody", "genuinely do that"],
    "background-applied fixes must be remembered for re-runs",
  );

  // The raw transcript is staged before fixes land, so `git diff` shows exactly what
  // the AI changed against the pristine version.
  const stagedMd = runCommand(
    "git",
    [
      "show",
      `:${path.relative(runRoot, path.join(episodeDir, "transcript.md"))}`,
    ],
    { cwd: runRoot },
  );
  assert.equal(stagedMd.status, 0, "raw transcript.md must be staged");
  assert.ok(
    stagedMd.stdout.includes("Why would anyone actually do that"),
    "the staged copy must be the unfixed transcript",
  );
  // No ticked or remembered fixes existed at write time; the AI's own fixes landed
  // from the background job above.
  assert.equal(report.transcriptFixes.attempted, 0);

  // Shownotes links from the UI land in the Links section: URL rows as markdown
  // links, title-only rows as bare text.
  const writtenIndex = fs.readFileSync(
    path.join(episodeDir, "index.md"),
    "utf8",
  );
  assert.ok(writtenIndex.includes("[Cool Bug](https://example.com/bug)"));
  assert.ok(writtenIndex.includes("\nA Game With No Steam Page\n"));
  assert.equal(report.shownotesLinks.length, 2);

  // Podcast-namespace chapters ride the episode bundle for the feed's
  // <podcast:chapters> tag.
  const writtenChapters = JSON.parse(
    fs.readFileSync(path.join(episodeDir, "chapters.json"), "utf8"),
  );
  assert.equal(writtenChapters.version, "1.2.0");
  // The hidden chapter mirrors the MP3's CHAP/CTOC split: present with toc false, so
  // players mark the segment without listing (or spoiling) it.
  assert.deepEqual(writtenChapters.chapters, [
    { startTime: 0, title: "Intro" },
    { startTime: 30, title: "Stardew Valley" },
    { startTime: 45, title: "Secret Game", toc: false },
  ]);

  // The AI clip picks land in the state from the background job, grounded in the
  // VTT timings; the run's own response only carried heuristics.
  assert.equal(report.clipSource, "heuristic");
  const savedState = analyzedState;
  assert.equal(savedState.clipSource, "llm");
  assert.equal(savedState.clipSuggestions.length, 1);
  assert.equal(savedState.clipSuggestions[0].startSeconds, 45);
  assert.equal(savedState.clipSuggestions[0].endSeconds, 72);
  assert.equal(
    savedState.clipSuggestions[0].summary,
    "A good idea at the time",
  );
  assert.equal(savedState.clipSuggestions[0].speaker, "Al");

  // Content is on disk, so the state machine must have landed in "generated"; a
  // skipped video leaves no mp4Render job behind.
  assert.equal(savedState.phase, "generated");
  assert.equal(savedState.jobs.mp4Render, undefined);

  // Medium fixes applied after a run (recorded in the state by the review endpoint)
  // must survive a re-run, which regenerates the transcripts from source.
  savedState.appliedTranscriptFixes = [
    { quote: "honestly", correction: "frankly" },
  ];
  fs.writeFileSync(
    path.join(episodeDir, "postprocess-state.json"),
    JSON.stringify(savedState),
  );

  const { report: rerunReport } = await runPipeline({
    repoRoot: runRoot,
    mp3Path: runMp3,
    transcriptMdPath: fixture.transcriptMdPath,
    transcriptVttPath: fixture.transcriptVttPath,
    skipVideo: true,
    onProgress: () => {},
    llmComplete: async ({ schema }) =>
      schema?.properties?.clips ? fakeClips : { findings: [] },
  });
  await waitForAiAnalysis(episodeDir);

  // Nothing the embed writes changed between the runs, so the MP3's bytes must be
  // left alone - re-approving must not invalidate upload checksums or the render.
  assert.equal(
    rerunReport.mp3ChapterImages.unchanged,
    true,
    "an unchanged re-run must skip the MP3 embed",
  );
  assert.equal(
    rerunReport.mp3Embed.mp3Sha256,
    report.mp3Embed.mp3Sha256,
    "the MP3 checksum must be stable across unchanged re-runs",
  );

  const rerunMd = fs.readFileSync(
    path.join(episodeDir, "transcript.md"),
    "utf8",
  );
  assert.ok(
    rerunMd.includes("frankly"),
    "previously applied medium fix was dropped by the re-run",
  );
  assert.deepEqual(
    rerunReport.appliedTranscriptFixes,
    [{ quote: "honestly", correction: "frankly" }],
    "applied fixes must carry forward into the new report",
  );

  // A re-run without an explicit link list keeps the last run's edited links rather
  // than resetting to the auto-resolved Steam set.
  const rerunIndex = fs.readFileSync(path.join(episodeDir, "index.md"), "utf8");
  assert.ok(
    rerunIndex.includes("[Cool Bug](https://example.com/bug)"),
    "shownotes links were not carried through the re-run",
  );

  // Reopening a generated episode skips the review-phase lookups: no audio QC decode,
  // no Steam requests.
  const reopenProgress = [];
  const reopened = await discoverEpisodeData({
    repoRoot: runRoot,
    mp3Path: runMp3,
    transcriptMdPath: fixture.transcriptMdPath,
    transcriptVttPath: fixture.transcriptVttPath,
    // The UI's editable main-topic box arrives as an override and drives the
    // derived description.
    mainTopic: "Custom Topic",
    onProgress: (message) => reopenProgress.push(message),
  });
  assert.equal(reopened.mainTopic, "Custom Topic");
  assert.ok(
    reopened.description.includes("Custom Topic"),
    "the derived description must follow the main-topic override",
  );
  assert.ok(
    reopenProgress.some((message) => /already generated/.test(message)),
    "reopen must announce the skipped lookups",
  );
  assert.equal(reopened.audioQc.enabled, false, "audio QC must be skipped");
  assert.ok(
    !reopenProgress.some((message) => /Steam links|audio levels/.test(message)),
    "review-phase lookups must not run on a generated episode",
  );

  // A retitle changes the directory slug: the run must find the old slug's state by
  // episode code, carry its memory, and re-home it beside the new files.
  const { report: retitledReport } = await runPipeline({
    repoRoot: runRoot,
    mp3Path: runMp3,
    transcriptMdPath: fixture.transcriptMdPath,
    transcriptVttPath: fixture.transcriptVttPath,
    episodeTitle: "Renamed Episode",
    skipVideo: true,
    onProgress: () => {},
    llmComplete: async ({ schema }) =>
      schema?.properties?.clips ? fakeClips : { findings: [] },
  });
  const renamedDir = retitledReport.episode.outputDirectory;
  assert.notEqual(renamedDir, episodeDir);
  assert.notEqual(
    retitledReport.mp3ChapterImages.unchanged,
    true,
    "a new title must re-embed (the ID3 title changed)",
  );
  await waitForAiAnalysis(renamedDir);
  assert.ok(
    !fs.existsSync(path.join(episodeDir, "postprocess-state.json")),
    "the old slug's state file must migrate away",
  );
  assert.ok(
    fs
      .readFileSync(path.join(renamedDir, "transcript.md"), "utf8")
      .includes("frankly"),
    "fix memory must survive the retitle",
  );

  fs.rmSync(repoRoot, { recursive: true, force: true });
  fs.rmSync(runRoot, { recursive: true, force: true });
  console.log("pipeline test passed", { survivors: survivors.length });
}

main().catch((error) => {
  console.error("pipeline test failed:", error.message);
  process.exit(1);
});
