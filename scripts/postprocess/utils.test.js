const assert = require("node:assert/strict");
const {
  chapterImageOverridesPath,
  formatZonedTimestamp,
  getUpcomingWednesdayDateString,
  parseByteRange,
  runCommandStream,
} = require("./utils");

function realOffsetFor(stamp, timezone) {
  const label = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date(stamp))
    .find((part) => part.type === "timeZoneName").value;
  const offset = label.replace("GMT", "");
  return offset === "" ? "+00:00" : offset;
}

// The offset written into frontmatter must match what the zone is really doing at that
// instant, and the wall clock must still read as the configured release time locally.
function assertStampIsHonest(stamp, timezone = "Europe/London") {
  assert.equal(
    stamp.slice(19),
    realOffsetFor(stamp, timezone),
    `${stamp} claims an offset the zone was not using`,
  );
  const localHour = new Date(stamp)
    .toLocaleString("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
    })
    .trim();
  assert.equal(
    localHour,
    stamp.slice(11, 13),
    `${stamp} does not read as that local time`,
  );
}

const wednesdaySamples = [
  "2026-01-05",
  "2026-02-10",
  "2026-03-24",
  "2026-03-27",
  "2026-03-31",
  "2026-06-15",
  "2026-08-12",
  "2026-10-20",
  "2026-10-27",
  "2026-11-10",
  "2026-12-15",
];

for (const day of wednesdaySamples) {
  const stamp = getUpcomingWednesdayDateString({
    now: new Date(`${day}T12:00:00Z`),
    time: "19:00:00",
    timezone: "Europe/London",
  });
  assertStampIsHonest(stamp);
  assert.equal(new Date(stamp).getUTCDay(), 3, `${stamp} is not a Wednesday`);
}

// GMT and BST must produce different offsets for the same wall-clock time.
assert.equal(
  formatZonedTimestamp({
    year: 2026,
    month: 1,
    day: 7,
    time: "19:00:00",
    timezone: "Europe/London",
  }),
  "2026-01-07T19:00:00+00:00",
);
assert.equal(
  formatZonedTimestamp({
    year: 2026,
    month: 8,
    day: 19,
    time: "19:00:00",
    timezone: "Europe/London",
  }),
  "2026-08-19T19:00:00+01:00",
);

// A time that coerces to 0 must not be mistaken for a valid midnight release.
assert.equal(
  formatZonedTimestamp({
    year: 2026,
    month: 8,
    day: 19,
    time: "",
    timezone: "Europe/London",
  }).slice(11, 19),
  "00:00:00",
  "empty time still yields midnight here; config.js is what rejects it",
);

assert.equal(
  chapterImageOverridesPath("/repo"),
  "/repo/data/chapter-image-overrides.json",
);

// writeJson goes through a temp file and rename; the write must land, overwrite
// existing content, and leave no temp file behind.
{
  const fsLocal = require("node:fs");
  const osLocal = require("node:os");
  const pathLocal = require("node:path");
  const { readJson, writeJson } = require("./utils");
  const dir = fsLocal.mkdtempSync(
    pathLocal.join(osLocal.tmpdir(), "ths-json-"),
  );
  const target = pathLocal.join(dir, "nested", "state.json");
  writeJson(target, { a: 1 });
  writeJson(target, { a: 2 });
  assert.deepEqual(readJson(target), { a: 2 });
  assert.deepEqual(
    fsLocal.readdirSync(pathLocal.dirname(target)),
    ["state.json"],
    "temp file left behind",
  );
  fsLocal.rmSync(dir, { recursive: true, force: true });
}

// Byte ranges for audio serving: the three header forms, clamping past EOF, and the
// unsatisfiable cases that must produce a 416 rather than a broken stream.
assert.deepEqual(parseByteRange("bytes=0-499", 1000), { start: 0, end: 499 });
assert.deepEqual(parseByteRange("bytes=500-", 1000), { start: 500, end: 999 });
assert.deepEqual(parseByteRange("bytes=-200", 1000), { start: 800, end: 999 });
assert.deepEqual(parseByteRange("bytes=0-9999", 1000), { start: 0, end: 999 });
assert.deepEqual(parseByteRange("bytes=-9999", 1000), { start: 0, end: 999 });
assert.equal(parseByteRange("bytes=1000-", 1000), "unsatisfiable");
assert.equal(parseByteRange("bytes=700-600", 1000), "unsatisfiable");
assert.equal(parseByteRange("bytes=-0", 1000), "unsatisfiable");
assert.equal(parseByteRange(undefined, 1000), null);
assert.equal(parseByteRange("bytes=-", 1000), null);
assert.equal(parseByteRange("bytes=0-100,200-300", 1000), null);
assert.equal(parseByteRange("items=0-100", 1000), null);
assert.equal(parseByteRange("bytes=0-", 0), null);

console.log("utils test passed", {
  wednesdaysChecked: wednesdaySamples.length,
});

// Aborting the signal must kill the spawned process and reject, rather than waiting
// out the command - this is what the clip generation cancel button relies on.
(async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = runCommandStream(
    "node",
    ["-e", "setTimeout(() => {}, 30000)"],
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 100);

  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.ok(
    Date.now() - startedAt < 10_000,
    "abort should not wait for the command to finish",
  );
  console.log("runCommandStream abort test passed");
})().catch((error) => {
  console.error("runCommandStream abort test failed:", error.message);
  process.exit(1);
});
