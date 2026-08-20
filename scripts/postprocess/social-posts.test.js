const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  composeBlueskyPost,
  composeTumblrPost,
  generateSocialPosts,
  generateSocialPostsCached,
} = require("./social-posts");

const episode = {
  title: "THS Secret Lair",
  description: "Kevin and Chelsea talk about all the latest news.",
  chapters: ["Intro", "Game Releases", "Outro"],
  clipHooks: [
    { title: "Frog Island Release", caption: "Cottagecore frogs!" },
    { title: "Capybara Takeover" },
  ],
  episodeUrl: "https://harvestseason.club/episode/year3/winter/12-07-x/",
  mainTopic: "Game Releases",
};

async function main() {
  // The model writes the text; hashtags and link are appended deterministically, and
  // the prompt carries the clip hooks as material.
  const prompts = [];
  const result = await generateSocialPosts({
    episode,
    llm: { provider: "gemini", model: "m", apiKey: "k" },
    complete: async ({ prompt }) => {
      prompts.push(prompt);
      return {
        bluesky: "New episode! Frogs, capybaras, and rum.",
        tumblrTitle: "Secret Lair time",
        tumblrBody: "Paragraph one.\n\nParagraph two.",
      };
    },
  });

  assert.ok(prompts[0].includes("Frog Island Release — Cottagecore frogs!"));
  assert.equal(
    result.bluesky,
    "New episode! Frogs, capybaras, and rum.\n\n#cottagecore #cozygames #farminggames\n\nhttps://harvestseason.club/episode/year3/winter/12-07-x/\n",
  );
  assert.equal(
    result.tumblr,
    "Secret Lair time\n\nParagraph one.\n\nParagraph two.\n\nhttps://harvestseason.club/episode/year3/winter/12-07-x/\n\nTags: the harvest season, podcast, cottagecore, cozy games, farming games, game releases\n",
  );
  assert.equal(result.blueskyOverLimit, false);
  assert.ok(result.blueskyLength > 0);

  // Without an LLM the fallback drafts still produce both posts.
  const fallback = await generateSocialPosts({ episode, llm: null });
  assert.ok(fallback.bluesky.includes("THS Secret Lair"));
  assert.ok(fallback.tumblr.includes("Frog Island Release"));

  // Over-limit detection: a body at the model cap plus tags and a long URL can pass
  // 300; the flag is how the UI warns.
  const long = composeBlueskyPost("x".repeat(250), episode.episodeUrl);
  assert.ok(long.trim().length > 300);

  assert.ok(
    composeTumblrPost({
      title: "T",
      body: "B",
      episodeUrl: "https://x/",
      mainTopic: "cottagecore",
    }).includes("Tags: the harvest season, podcast, cottagecore,"),
  );

  // Cache: identical inputs hit; changed episode data re-runs.
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ths-social-"));
  let calls = 0;
  const countingComplete = async () => {
    calls += 1;
    return { bluesky: "b", tumblrTitle: "t", tumblrBody: "p" };
  };
  const llm = { provider: "gemini", model: "m", apiKey: "k" };

  const first = await generateSocialPostsCached({
    cacheDir,
    episode,
    llm,
    complete: countingComplete,
  });
  assert.equal(first.fromCache, false);
  const second = await generateSocialPostsCached({
    cacheDir,
    episode,
    llm,
    complete: countingComplete,
  });
  assert.equal(second.fromCache, true);
  assert.equal(calls, 1);

  await generateSocialPostsCached({
    cacheDir,
    episode: { ...episode, description: "changed" },
    llm,
    complete: countingComplete,
  });
  assert.equal(calls, 2, "changed episode data must re-run");

  fs.rmSync(cacheDir, { recursive: true, force: true });
  console.log("social-posts test passed");
}

main().catch((error) => {
  console.error("social-posts test failed:", error.message);
  process.exit(1);
});
