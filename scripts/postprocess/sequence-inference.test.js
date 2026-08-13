const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  inferNextSeasonEpisode,
  inferPublishDateForEpisode,
} = require("./sequence-inference");

function makeContentRoot(episodes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ths-seq-"));
  for (const { season, episode, date } of episodes) {
    const dir = path.join(root, "year3", "winter", `${season}-${episode}-x`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "index.md"),
      [
        "---",
        `season: "${Number(season)}"`,
        `episode: "${Number(episode)}"`,
        `date: ${date}`,
        "---",
        "",
      ].join("\n"),
    );
  }
  return root;
}

const options = {
  releaseTimeLocal: "19:00:00",
  timezone: "Europe/London",
};

// Inferred dates must use the zone's real offset, not a fixed one, and must keep the
// release time put when the target lands on the other side of a DST change.
const acrossDstRoot = makeContentRoot([
  { season: "12", episode: "05", date: "2026-10-07T19:00:00+01:00" },
]);
const acrossDst = inferPublishDateForEpisode({
  contentEpisodeRoot: acrossDstRoot,
  seasonNumber: 12,
  episodeNumber: 9,
  ...options,
});
assert.equal(acrossDst, "2026-11-04T19:00:00+00:00");
assert.ok(!acrossDst.endsWith("Z"), "must not emit a UTC Z string");

// Within a single offset period the step is a plain four weeks.
const withinBstRoot = makeContentRoot([
  { season: "12", episode: "05", date: "2026-06-03T19:00:00+01:00" },
]);
assert.equal(
  inferPublishDateForEpisode({
    contentEpisodeRoot: withinBstRoot,
    seasonNumber: 12,
    episodeNumber: 9,
    ...options,
  }),
  "2026-07-01T19:00:00+01:00",
);

// With no episodes on disk it falls back to the next Wednesday.
const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ths-seq-empty-"));
assert.match(
  inferPublishDateForEpisode({
    contentEpisodeRoot: emptyRoot,
    seasonNumber: 1,
    episodeNumber: 1,
    ...options,
  }),
  /^\d{4}-\d{2}-\d{2}T19:00:00[+-]\d{2}:\d{2}$/,
);

// Episode numbering rules: increment, season cap, and the Jan/Jul calendar boundary.
const incrementRoot = makeContentRoot([
  { season: "12", episode: "05", date: "2026-08-05T19:00:00+01:00" },
]);
const incremented = inferNextSeasonEpisode({
  contentEpisodeRoot: incrementRoot,
  ...options,
});
assert.equal(incremented.seasonCode, "12");
assert.equal(incremented.episodeCode, "06");
assert.equal(incremented.reason, "increment");

const cappedRoot = makeContentRoot([
  { season: "12", episode: "26", date: "2026-08-05T19:00:00+01:00" },
]);
const capped = inferNextSeasonEpisode({
  contentEpisodeRoot: cappedRoot,
  ...options,
});
assert.equal(capped.seasonCode, "13");
assert.equal(capped.episodeCode, "01");
assert.equal(capped.reason, "max-episodes");

const boundaryRoot = makeContentRoot([
  { season: "12", episode: "10", date: "2026-12-30T19:00:00+00:00" },
]);
const boundary = inferNextSeasonEpisode({
  contentEpisodeRoot: boundaryRoot,
  publishDate: "2027-01-06T19:00:00+00:00",
  ...options,
});
assert.equal(boundary.seasonCode, "13");
assert.equal(boundary.episodeCode, "01");
assert.equal(boundary.reason, "calendar-boundary");

// A break that skips clean over the boundary month must still roll the season: the
// rule is "first episode released after 30 Jun / 31 Dec", not "released in Jul/Jan".
const hiatusRoot = makeContentRoot([
  { season: "12", episode: "22", date: "2026-06-24T19:00:00+01:00" },
]);
const afterHiatus = inferNextSeasonEpisode({
  contentEpisodeRoot: hiatusRoot,
  publishDate: "2026-08-12T19:00:00+01:00",
  ...options,
});
assert.equal(afterHiatus.seasonCode, "13");
assert.equal(afterHiatus.episodeCode, "01");
assert.equal(afterHiatus.reason, "calendar-boundary");

// Boundary detection uses the configured timezone, not the machine's. 1 Jan 03:00
// Auckland time is still 31 Dec in London, so a London-configured show has not
// crossed the boundary yet - regardless of where the tool runs.
const tzEdgeRoot = makeContentRoot([
  { season: "12", episode: "10", date: "2026-12-23T19:00:00+00:00" },
]);
const tzEdge = inferNextSeasonEpisode({
  contentEpisodeRoot: tzEdgeRoot,
  publishDate: "2027-01-01T03:00:00+13:00",
  ...options,
});
assert.equal(tzEdge.seasonCode, "12");
assert.equal(tzEdge.reason, "increment");

// 2026's first half has only 25 Wednesdays (non-leap year starting Thursday), so an
// unbroken winter season takes its 26th episode on the first Wednesday of July...
const spillRoot = makeContentRoot([
  { season: "12", episode: "25", date: "2026-06-24T19:00:00+01:00" },
]);
const spilled = inferNextSeasonEpisode({
  contentEpisodeRoot: spillRoot,
  publishDate: "2026-07-01T19:00:00+01:00",
  ...options,
});
assert.equal(spilled.seasonCode, "12");
assert.equal(spilled.episodeCode, "26");
assert.equal(spilled.reason, "spill-into-july");

// ...but only episode 26, only onto the first Wednesday, and never across a year end.
const afterSpillRoot = makeContentRoot([
  { season: "12", episode: "26", date: "2026-07-01T19:00:00+01:00" },
]);
const afterSpill = inferNextSeasonEpisode({
  contentEpisodeRoot: afterSpillRoot,
  publishDate: "2026-07-08T19:00:00+01:00",
  ...options,
});
assert.equal(afterSpill.seasonCode, "13");
assert.equal(afterSpill.episodeCode, "01");
assert.equal(afterSpill.reason, "max-episodes");

const lateSpillAttempt = inferNextSeasonEpisode({
  contentEpisodeRoot: spillRoot,
  publishDate: "2026-07-08T19:00:00+01:00",
  ...options,
});
assert.equal(lateSpillAttempt.seasonCode, "13");
assert.equal(lateSpillAttempt.reason, "calendar-boundary");

const yearSpillRoot = makeContentRoot([
  { season: "13", episode: "25", date: "2026-12-30T19:00:00+00:00" },
]);
const yearSpillAttempt = inferNextSeasonEpisode({
  contentEpisodeRoot: yearSpillRoot,
  publishDate: "2027-01-06T19:00:00+00:00",
  ...options,
});
assert.equal(yearSpillAttempt.seasonCode, "14");
assert.equal(
  yearSpillAttempt.reason,
  "calendar-boundary",
  "episode 26 must never spill into a new year",
);

// After a spilled season, the next season's inferred dates start on the first
// Wednesday after the spilled episode, not on the (already used) boundary Wednesday.
assert.equal(
  inferPublishDateForEpisode({
    contentEpisodeRoot: afterSpillRoot,
    seasonNumber: 13,
    episodeNumber: 1,
    ...options,
  }),
  "2026-07-08T19:00:00+01:00",
);

// A future season's dates anchor on the calendar boundary, not on 26-per-season
// ordinal maths: season 12 ended early at e22, and 13-01 releases on the first
// Wednesday after 1 Jul (which in 2026 is 1 Jul itself), not four phantom weeks later.
const shortSeasonRoot = makeContentRoot([
  { season: "12", episode: "22", date: "2026-06-24T19:00:00+01:00" },
]);
assert.equal(
  inferPublishDateForEpisode({
    contentEpisodeRoot: shortSeasonRoot,
    seasonNumber: 13,
    episodeNumber: 1,
    ...options,
  }),
  "2026-07-01T19:00:00+01:00",
);
assert.equal(
  inferPublishDateForEpisode({
    contentEpisodeRoot: shortSeasonRoot,
    seasonNumber: 13,
    episodeNumber: 3,
    ...options,
  }),
  "2026-07-15T19:00:00+01:00",
);
// Two seasons ahead lands on the first Wednesday of the following January.
assert.equal(
  inferPublishDateForEpisode({
    contentEpisodeRoot: shortSeasonRoot,
    seasonNumber: 14,
    episodeNumber: 1,
    ...options,
  }),
  "2027-01-06T19:00:00+00:00",
);

console.log("sequence-inference test passed", { acrossDst });
