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

console.log("sequence-inference test passed", { acrossDst });
