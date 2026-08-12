const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generateClipVideos } = require("./video");
const { runCommand } = require("./utils");

// Real episode folders live under "Google Drive/My Drive", so exercise a path with
// spaces to keep the filtergraph escaping honest.
const base = fs.mkdtempSync(path.join(os.tmpdir(), "ths video test "));

const imagePath = path.join(base, "img.png");
const mp3Path = path.join(base, "audio.mp3");
for (const args of [
  [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x224466:s=800x800:d=1",
    "-frames:v",
    "1",
    imagePath,
  ],
  ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=12", mp3Path],
]) {
  const result = runCommand("ffmpeg", args);
  assert.equal(result.status, 0, `fixture ffmpeg failed: ${result.stderr}`);
}

const progressEvents = [];

generateClipVideos({
  clipSuggestions: [
    // Unequal durations, so count-based percent (50 after clip one) and time-based
    // percent (25 after clip one) disagree and the test can tell them apart.
    {
      title: "One",
      summary: "First clip",
      startSeconds: 0,
      durationSeconds: 2,
    },
    {
      title: "Two",
      summary: "Second clip",
      startSeconds: 3,
      durationSeconds: 6,
    },
  ],
  imagePath,
  mp3Path,
  outputDir: path.join(base, "out"),
  workDir: path.join(base, ".work"),
  // "%" is a drawtext expansion sequence and killed renders until expansion=none; the
  // colon, apostrophe and comma each need filtergraph escaping. A long title must wrap
  // rather than overflow the frame.
  episodeTitle:
    "Wait: it's 50% done, right? A very long episode title that certainly cannot fit on one line of the frame",
  episodeDateString: "2026-08-19T19:00:00+01:00",
  onProgress: (progress) => progressEvents.push(progress),
})
  .then((outputs) => {
    assert.equal(outputs.length, 2);
    for (const output of outputs) {
      const stat = fs.statSync(output.outputPath);
      assert.ok(
        stat.size > 10_000,
        `${output.outputPath} looks empty (${stat.size} bytes)`,
      );
    }

    // The overlay files are what drawtext actually rendered: wrapped title lines in one,
    // the formatted date in the other, shared by every clip in the episode.
    const titleLines = fs
      .readFileSync(path.join(base, ".work", "title.txt"), "utf8")
      .trim()
      .split("\n");
    assert.ok(titleLines.length >= 2, "long title was not wrapped");
    assert.ok(titleLines[0].includes("50%"), "punctuation was mangled");
    assert.equal(
      fs.readFileSync(path.join(base, ".work", "date.txt"), "utf8").trim(),
      "19 August 2026",
    );

    // Percent is weighted by rendered seconds, not clip count: after the 2s clip of an
    // 8s batch it must read 25, and it must only ever move forward.
    const afterFirstClip = progressEvents.find((event) => event.current === 1);
    assert.equal(afterFirstClip.percent, 25, "percent is not time-weighted");
    assert.equal(progressEvents[progressEvents.length - 1].percent, 100);
    for (let i = 1; i < progressEvents.length; i += 1) {
      assert.ok(
        progressEvents[i].percent >= progressEvents[i - 1].percent,
        "percent went backwards",
      );
    }

    fs.rmSync(base, { recursive: true, force: true });
    console.log("video label test passed", {
      progressEvents: progressEvents.length,
    });
  })
  .catch((error) => {
    console.error("video label test failed:", error.message.slice(-400));
    process.exit(1);
  });
