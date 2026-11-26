const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { listEpisodeSourceFolders } = require("./episode-discovery");

function makeEpisodesRoot(layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ths-episodes-"));
  for (const [relative, files] of Object.entries(layout)) {
    const dir = path.join(root, relative);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of files) {
      fs.writeFileSync(path.join(dir, name), "");
    }
  }
  return root;
}

test("listEpisodeSourceFolders reports each coded folder with its input files", () => {
  const root = makeEpisodesRoot({
    "12-26 - GOTY 2026": [
      "ths-12-26.mp3",
      "GOTY.md",
      "GOTY.vtt",
      "GOTY - Chapter info.txt",
      "readme.md",
    ],
    "13-01 - Upcoming 2027": ["Upcoming.md"],
    "12-27 - Nothing Yet": [],
    "Not An Episode": ["notes.md"],
    "archive/12-01 - Old One": ["ths-12-01.mp3", "Old.md", "Old.vtt"],
  });

  const episodes = listEpisodeSourceFolders({ episodesRoot: root });

  assert.deepEqual(
    episodes.map((episode) => episode.code),
    ["12-01", "12-26", "12-27", "13-01"],
  );

  const goty = episodes.find((episode) => episode.code === "12-26");
  assert.equal(goty.name, "GOTY 2026");
  assert.equal(goty.seasonNumber, 12);
  assert.equal(goty.episodeNumber, 26);
  assert.equal(path.basename(goty.mp3Path), "ths-12-26.mp3");
  assert.equal(path.basename(goty.transcriptMdPath), "GOTY.md");
  assert.equal(path.basename(goty.transcriptVttPath), "GOTY.vtt");
  assert.equal(goty.hasChapterInfo, true);

  const upcoming = episodes.find((episode) => episode.code === "13-01");
  assert.equal(upcoming.mp3Path, null);
  assert.equal(path.basename(upcoming.transcriptMdPath), "Upcoming.md");
  assert.equal(upcoming.transcriptVttPath, null);

  const empty = episodes.find((episode) => episode.code === "12-27");
  assert.equal(empty.mp3Path, null);
  assert.equal(empty.transcriptMdPath, null);
  assert.equal(empty.transcriptVttPath, null);

  // A nested folder is found, and non-coded folders are ignored.
  const old = episodes.find((episode) => episode.code === "12-01");
  assert.equal(old.name, "Old One");
});

test("listEpisodeSourceFolders never picks a readme as the transcript", () => {
  const root = makeEpisodesRoot({
    "12-05 - Readme Trap": ["ths-12-05.mp3", "readme.md", "Episode.vtt"],
  });

  const [episode] = listEpisodeSourceFolders({ episodesRoot: root });
  assert.equal(episode.transcriptMdPath, null);
  assert.equal(path.basename(episode.transcriptVttPath), "Episode.vtt");
});
