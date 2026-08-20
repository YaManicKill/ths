const assert = require("node:assert/strict");
const {
  buildYoutubeDescription,
  readShowLinksFromConfig,
} = require("./youtube-description");

// The show links come from the site's config.toml; absent platforms are skipped.
const showLinks = readShowLinksFromConfig(
  [
    'baseURL = "https://harvestseason.club/"',
    "[params]",
    '  applepodcasts = "https://apple.example/show"',
    '  spotify = "https://spotify.example/show"',
    "[menu]",
    "  [[menu.main]]",
    '    identifier = "patreon"',
    '    url = "https://www.patreon.com/thspod"',
  ].join("\n"),
);
assert.deepEqual(showLinks, {
  listenLinks: [
    "Apple Podcasts - https://apple.example/show",
    "Spotify - https://spotify.example/show",
  ],
  patreonUrl: "https://www.patreon.com/thspod",
  baseUrl: "https://harvestseason.club/",
});
assert.deepEqual(readShowLinksFromConfig(""), {
  listenLinks: [],
  patreonUrl: null,
  baseUrl: null,
});

// Mirrors the real generated index.md shape, including a hand-added link group and a
// bare no-URL title.
const indexMdText = [
  "---",
  'title: "Boots and Snoots"',
  'episode: "6"',
  'Description: "Codey and Chelsea talk about Bee Simulator."',
  "date: 2026-08-12T19:00:00+01:00",
  "---",
  "",
  "## Timings",
  "",
  "00:00:00: Theme Tune",
  "00:00:30: Intro",
  "00:16:08: Codey's Entomology Corner",
  "02:03:58: Bee Simulator",
  "",
  "## Links",
  "",
  "[Codey's New Bug](https://www.inaturalist.org/observations/239496363)",
  "A Game With No Steam Page",
  "",
  "[Bee Simulator](https://store.steampowered.com/app/914750/Bee_Simulator/)",
  "",
  "## Contact",
  "",
  "Al on Mastodon: https://mastodon.scot/@TheScotBot",
  "Email Us: https://harvestseason.club/contact/",
  "",
].join("\n");

const description = buildYoutubeDescription({
  indexMdText,
  episodeUrl:
    "https://www.harvestseason.club/episode/year3/winter/12-06-boots-and-snoots/",
  showLinks: {
    listenLinks: [
      "Apple Podcasts - https://itunes.apple.com/podcast/the-harvest-season/id1449112246?mt=2",
      "Spotify - https://open.spotify.com/show/1T6fbWhiBgH2Ym85KloVEs",
      "Pocket Casts - https://pca.st/z5HX",
      "Overcast - https://overcast.fm/itunes1449112246",
    ],
    patreonUrl: "https://www.patreon.com/thspod",
  },
});

assert.equal(
  description,
  [
    "Codey and Chelsea talk about Bee Simulator.",
    "",
    "Full shownotes: https://www.harvestseason.club/episode/year3/winter/12-06-boots-and-snoots/",
    "",
    "Chapters:",
    "0:00 Theme Tune",
    "0:30 Intro",
    "16:08 Codey's Entomology Corner",
    "2:03:58 Bee Simulator",
    "",
    "Links:",
    "Codey's New Bug - https://www.inaturalist.org/observations/239496363",
    "A Game With No Steam Page",
    "",
    "Bee Simulator - https://store.steampowered.com/app/914750/Bee_Simulator/",
    "",
    "Listen to the podcast:",
    "Apple Podcasts - https://itunes.apple.com/podcast/the-harvest-season/id1449112246?mt=2",
    "Spotify - https://open.spotify.com/show/1T6fbWhiBgH2Ym85KloVEs",
    "Pocket Casts - https://pca.st/z5HX",
    "Overcast - https://overcast.fm/itunes1449112246",
    "",
    "Support us on Patreon - https://www.patreon.com/thspod",
    "",
    "Al on Mastodon: https://mastodon.scot/@TheScotBot",
    "Email Us: https://harvestseason.club/contact/",
    "",
    "#theharvestseason #cottagecore #farminggames",
    "",
  ].join("\n"),
);

// An episode with the empty-links placeholder gets no Links block, and absent show
// links produce no boilerplate blocks - only the hashtags are unconditional.
const bare = buildYoutubeDescription({
  indexMdText: [
    "---",
    'Description: "Test."',
    "---",
    "",
    "## Timings",
    "",
    "00:00:00: Intro",
    "",
    "## Links",
    "",
    "[]()",
    "",
  ].join("\n"),
});
assert.ok(bare.startsWith("Test.\n\nChapters:\n0:00 Intro\n"));
assert.ok(!bare.includes("Links:"));
assert.ok(!bare.includes("Listen to the podcast:"));
assert.ok(
  bare.trimEnd().endsWith("#theharvestseason #cottagecore #farminggames"),
);

console.log("youtube-description test passed");
