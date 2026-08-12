const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  charactersPerLine,
  fontCandidatesForPlatform,
  resolveClipFontPath,
  wrapLabelText,
  writeLabelTextFile,
} = require("./clip-text");

// The label frame is 1080px wide with a 60px margin each side at fontsize 52.
const LABEL = { maxWidthPx: 960, fontSize: 52, maxLines: 3 };
const limit = charactersPerLine(LABEL);
assert.ok(limit > 20 && limit < 60, `implausible line limit: ${limit}`);

function assertLinesFit(lines, context) {
  for (const line of lines) {
    assert.ok(
      line.length <= limit + 1,
      `${context}: line of ${line.length} chars exceeds the ${limit} limit: ${JSON.stringify(line)}`,
    );
  }
}

// Short text stays on one line and is left alone.
assert.deepEqual(
  wrapLabelText({ text: "Do you not see these kids", ...LABEL }),
  ["Do you not see these kids"],
);

// The real failure case: a summary long enough to run off both edges of the frame.
const long =
  "Because it turns out the whole system is genuinely broken and that means you literally cannot win";
const longLines = wrapLabelText({ text: long, ...LABEL });
assert.ok(longLines.length > 1, "long text was not wrapped at all");
assert.ok(longLines.length <= 3, "wrapping exceeded maxLines");
assertLinesFit(longLines, "long summary");

// clip-suggestions allows summaries up to 180 chars, which must not silently overflow.
const maximal = "word ".repeat(40).trim();
const maximalLines = wrapLabelText({ text: maximal, ...LABEL });
assert.equal(maximalLines.length, 3, "expected the line cap to apply");
assertLinesFit(maximalLines, "maximal summary");
assert.ok(
  maximalLines[2].endsWith("…"),
  "truncated text should be marked with an ellipsis",
);

// Text that fits exactly at the cap must not be marked as truncated.
const exact = wrapLabelText({ text: "one two three", ...LABEL });
assert.ok(
  !exact.join("").includes("…"),
  "short text was wrongly marked as truncated",
);

// A single unbreakable token longer than a line must still be split, not overflow.
const hugeWord = "A".repeat(120);
const hugeLines = wrapLabelText({ text: hugeWord, ...LABEL });
assertLinesFit(hugeLines, "unbreakable word");

// Whitespace is normalised, and empty input yields nothing to draw.
assert.deepEqual(wrapLabelText({ text: "  a   b  ", ...LABEL }), ["a b"]);
assert.deepEqual(wrapLabelText({ text: "", ...LABEL }), []);
assert.deepEqual(wrapLabelText({ text: null, ...LABEL }), []);

// Font lookup: per-platform candidates, and a clear error naming what it tried.
for (const platform of ["darwin", "linux", "win32"]) {
  const candidates = fontCandidatesForPlatform(platform);
  assert.ok(candidates.length > 0, `no font candidates for ${platform}`);
  const resolved = resolveClipFontPath({
    platform,
    exists: (file) => file === candidates[candidates.length - 1],
  });
  assert.equal(
    resolved,
    candidates[candidates.length - 1],
    `${platform} did not fall through to a later candidate`,
  );
}

assert.throws(
  () => resolveClipFontPath({ platform: "linux", exists: () => false }),
  (error) =>
    error.message.includes("No usable font") &&
    error.message.includes("DejaVuSans.ttf"),
  "a missing font must fail with the paths it tried",
);

// On this machine a real font must resolve, since clips depend on it.
assert.ok(
  fs.existsSync(resolveClipFontPath()),
  "no font resolved on the current platform",
);

// The text file avoids drawtext escaping problems, so punctuation must survive verbatim.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ths-label-"));
const tricky = "Wait: it's 50% done, right? A\\B";
const trickyLines = wrapLabelText({ text: tricky, ...LABEL });
const written = writeLabelTextFile({
  lines: trickyLines,
  workDir,
  name: "label-001",
});
assert.equal(
  fs.readFileSync(written, "utf8").trim(),
  trickyLines.join("\n"),
  "label file did not round-trip the text",
);
assert.ok(
  fs.readFileSync(written, "utf8").includes("50%"),
  "punctuation was mangled on the way to the file",
);
fs.rmSync(workDir, { recursive: true, force: true });

console.log("clip-text test passed", { charsPerLine: limit });

// The clip overlay shows the release date as a plain human date, taken from the string's
// own date part so a timezone conversion can never shift the displayed day.
const { formatEpisodeDateForOverlay } = require("./clip-text");
assert.equal(
  formatEpisodeDateForOverlay("2026-08-19T19:00:00+01:00"),
  "19 August 2026",
);
assert.equal(
  formatEpisodeDateForOverlay("2026-01-07T19:00:00+00:00"),
  "7 January 2026",
);
assert.equal(formatEpisodeDateForOverlay("2026-12-31"), "31 December 2026");
assert.equal(formatEpisodeDateForOverlay("not a date"), null);
assert.equal(formatEpisodeDateForOverlay(""), null);
assert.equal(formatEpisodeDateForOverlay(undefined), null);

// The title face: bold where the platform has one, regular as the fallback rather than
// failing the run.
const {
  boldFontCandidatesForPlatform,
  resolveClipBoldFontPath,
} = require("./clip-text");

for (const platform of ["darwin", "linux", "win32"]) {
  const bolds = boldFontCandidatesForPlatform(platform);
  assert.ok(bolds.length > 0, `no bold candidates for ${platform}`);
  assert.equal(
    resolveClipBoldFontPath({ platform, exists: (f) => f === bolds[0] }),
    bolds[0],
  );
}

const regularFallback = fontCandidatesForPlatform("linux")[0];
assert.equal(
  resolveClipBoldFontPath({
    platform: "linux",
    exists: (f) => f === regularFallback,
  }),
  regularFallback,
  "missing bold face should fall back to the regular font",
);

assert.ok(
  fs.existsSync(resolveClipBoldFontPath()),
  "no bold font resolved on the current platform",
);

// Bold glyphs are wider, so the same width fits fewer characters per line.
assert.ok(
  charactersPerLine({ maxWidthPx: 960, fontSize: 72, glyphWidthRatio: 0.58 }) <
    charactersPerLine({ maxWidthPx: 960, fontSize: 72 }),
);
