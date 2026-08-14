const assert = require("node:assert/strict");
const {
  buildAssSubtitles,
  formatAssTimestamp,
  sliceCuesForClip,
  stripSpeakerPrefix,
} = require("./clip-subtitles");

assert.equal(formatAssTimestamp(0), "0:00:00.00");
assert.equal(formatAssTimestamp(971.28), "0:16:11.28");
assert.equal(formatAssTimestamp(3661.5), "1:01:01.50");
assert.equal(formatAssTimestamp(-2), "0:00:00.00");
// Fractions that round up must roll into the next second (and minute), never emit a
// three-digit centisecond field that reads as an earlier time.
assert.equal(formatAssTimestamp(12.996), "0:00:13.00");
assert.equal(formatAssTimestamp(59.999), "0:01:00.00");
assert.equal(formatAssTimestamp(3599.995), "1:00:00.00");

assert.equal(
  stripSpeakerPrefix("Codey: Do you want to tell it?"),
  "Do you want to tell it?",
);
assert.equal(
  stripSpeakerPrefix("No prefix here at all"),
  "No prefix here at all",
);
// Mid-sentence colons are not speaker prefixes.
assert.equal(
  stripSpeakerPrefix("Warning: this is not a name"),
  "this is not a name",
  "single-word prefixes are indistinguishable from labels; both are stripped",
);

// Slicing keeps only cues overlapping the clip, rebases them to clip time, and clamps
// partial overlaps at the clip edges.
const cues = [
  { startSeconds: 5, endSeconds: 9, text: "Codey: before the clip" },
  { startSeconds: 9, endSeconds: 12, text: "Codey: straddles the start" },
  { startSeconds: 12, endSeconds: 16, text: "Chelsea: fully inside" },
  { startSeconds: 16, endSeconds: 24, text: "Codey: straddles the end" },
  { startSeconds: 24, endSeconds: 30, text: "Chelsea: after the clip" },
];
const sliced = sliceCuesForClip({
  cues,
  clipStartSeconds: 10,
  clipEndSeconds: 20,
});
assert.deepEqual(sliced, [
  { startSeconds: 0, endSeconds: 2, text: "straddles the start" },
  { startSeconds: 2, endSeconds: 6, text: "fully inside" },
  { startSeconds: 6, endSeconds: 10, text: "straddles the end" },
]);

// Per-clip exclusions drop cues by original start time (float-tolerant), leaving the
// rest untouched.
assert.deepEqual(
  sliceCuesForClip({
    cues,
    clipStartSeconds: 10,
    clipEndSeconds: 20,
    excludedCueStarts: [9.001, 16],
  }),
  [{ startSeconds: 2, endSeconds: 6, text: "fully inside" }],
);

assert.deepEqual(
  sliceCuesForClip({ cues, clipStartSeconds: 100, clipEndSeconds: 110 }),
  [],
  "a clip past the transcript has no subtitles",
);

// The ASS file: header pins the 1080x1920 canvas, dialogue lines carry rebased
// centisecond timings, and brace characters (libass override syntax) never survive.
const ass = buildAssSubtitles({
  cues: [
    { startSeconds: 0, endSeconds: 2.5, text: "First {line} here" },
    { startSeconds: 2.5, endSeconds: 6, text: "Second line" },
    { startSeconds: 6, endSeconds: 6, text: "zero duration is dropped" },
    { startSeconds: 7, endSeconds: 8, text: "   " },
  ],
  fontFamily: "Arial",
});
assert.ok(ass.includes("PlayResX: 1080"));
assert.ok(ass.includes("PlayResY: 1920"));
assert.ok(ass.includes("Style: Clip,Arial,56"));
assert.ok(
  ass.includes(
    "Dialogue: 0,0:00:00.00,0:00:02.50,Clip,,0,0,0,,First line here",
  ),
  "brace characters must be removed, not escaped",
);
assert.ok(
  ass.includes("Dialogue: 0,0:00:02.50,0:00:06.00,Clip,,0,0,0,,Second line"),
);
assert.equal(
  ass.split("\n").filter((line) => line.startsWith("Dialogue:")).length,
  2,
  "zero-duration and empty cues must be dropped",
);

console.log("clip-subtitles test passed");
