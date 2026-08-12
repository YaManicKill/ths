const assert = require("node:assert/strict");
const fs = require("node:fs");
const { parseVttCues, parseVttTimestamp } = require("./vtt");

assert.equal(parseVttTimestamp("00:16:11.280"), 971.28);
assert.equal(parseVttTimestamp("16:11.280"), 971.28);
assert.equal(parseVttTimestamp("01:00:00.000"), 3600);
assert.equal(parseVttTimestamp("garbage"), null);
assert.equal(parseVttTimestamp(""), null);

// Mirrors the real transcripts: a STYLE block, voice tags, cue settings, and an
// identifier line before a timing line.
const sample = [
  "WEBVTT",
  "",
  "STYLE",
  '::cue(v[voice="ABC"])',
  "{",
  "    color: #00D2E0;",
  "}",
  "",
  "1",
  "00:00:30.000 --> 00:00:33.960",
  "<v ABC>Codey: Hello, farmers, and welcome to another episode.",
  "",
  "2",
  "00:00:33.960 --> 00:00:35.100 align:start position:0%",
  "<v ABC>Codey: My name is Cody.",
  "",
  "NOTE this is a comment",
  "",
  "broken cue with no timing",
  "",
  "00:01:00.000 --> 00:00:59.000",
  "end before start must be dropped",
].join("\n");

const cues = parseVttCues(sample);
assert.equal(cues.length, 2, "expected exactly the two valid cues");
assert.deepEqual(cues[0], {
  startSeconds: 30,
  endSeconds: 33.96,
  text: "Codey: Hello, farmers, and welcome to another episode.",
});
assert.equal(
  cues[1].startSeconds,
  33.96,
  "cue settings after the end timestamp broke parsing",
);
assert.ok(!cues[1].text.includes("<v"), "voice markup was not stripped");

// Out-of-order cues come back sorted, since snapping binary-searches by start time.
const unordered = parseVttCues(
  "WEBVTT\n\n00:00:10.000 --> 00:00:11.000\nsecond\n\n00:00:05.000 --> 00:00:06.000\nfirst\n",
);
assert.deepEqual(
  unordered.map((cue) => cue.startSeconds),
  [5, 10],
);

assert.deepEqual(parseVttCues(""), []);
assert.deepEqual(parseVttCues(null), []);

// The parser must swallow a real episode's VTT whole: every cue timed, ordered, and
// stripped of markup.
const realPath =
  "content/episode/year3/winter/12-06-boots-and-snoots/transcript.vtt";
if (fs.existsSync(realPath)) {
  const real = parseVttCues(fs.readFileSync(realPath, "utf8"));
  assert.ok(
    real.length > 2000,
    `only parsed ${real.length} cues from the real VTT`,
  );
  for (let i = 1; i < real.length; i += 1) {
    assert.ok(
      real[i].startSeconds >= real[i - 1].startSeconds,
      "cues out of order",
    );
  }
  assert.ok(
    real.every(
      (cue) => cue.endSeconds > cue.startSeconds && !cue.text.includes("<"),
    ),
    "real VTT cue failed sanity checks",
  );
}

console.log("vtt test passed");
