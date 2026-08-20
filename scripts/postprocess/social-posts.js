const crypto = require("node:crypto");
const path = require("node:path");
const { completeJson } = require("./llm");
const { fileExists, readJson, writeJson } = require("./utils");

// Bump when the prompt or schema changes so cached posts are not reused.
const SOCIAL_PROMPT_VERSION = 1;

// Bluesky tags are discovery searches, not branding - the show name lives in the post
// text, the tags buy reach in the cozy-games corner.
const BLUESKY_HASHTAGS = ["#cottagecore", "#cozygames", "#farminggames"];
// Tumblr surfaces roughly the first five tags; these plus the episode's main topic.
const TUMBLR_BASE_TAGS = [
  "the harvest season",
  "podcast",
  "cottagecore",
  "cozy games",
  "farming games",
];

// Bluesky's limit is 300 characters including the link and hashtags, which are
// appended deterministically - this is what remains for the model's text.
const BLUESKY_BODY_LIMIT = 180;

const SOCIAL_SCHEMA = {
  type: "object",
  properties: {
    bluesky: {
      type: "string",
      description:
        "The Bluesky post text: energetic, names the episode and two or three concrete hooks. No hashtags, no links - they are appended separately. At most 180 characters.",
    },
    tumblrTitle: {
      type: "string",
      description: "A short post title for Tumblr.",
    },
    tumblrBody: {
      type: "string",
      description:
        "Two short, conversational paragraphs for Tumblr announcing the episode. No hashtags, no links.",
    },
  },
  required: ["bluesky", "tumblrTitle", "tumblrBody"],
};

const SYSTEM_PROMPT = [
  "You write social media posts announcing new episodes of The Harvest Season, a",
  "conversational podcast about farming and cottagecore games.",
  "",
  "Rules:",
  "- Lead with what makes THIS episode fun: name two or three concrete hooks from the",
  "  material provided, not generic enthusiasm.",
  "- Never put hashtags or links in the text; they are appended separately.",
  `- The Bluesky text must be at most ${BLUESKY_BODY_LIMIT} characters.`,
  "- The Tumblr body is two short, conversational paragraphs in the show's voice.",
].join("\n");

function composeBlueskyPost(body, episodeUrl) {
  return `${String(body || "").trim()}\n\n${BLUESKY_HASHTAGS.join(" ")}\n\n${episodeUrl}\n`;
}

function composeTumblrPost({ title, body, episodeUrl, mainTopic }) {
  const tags = [...TUMBLR_BASE_TAGS];
  if (mainTopic && !tags.includes(mainTopic.toLowerCase())) {
    tags.push(mainTopic.toLowerCase());
  }
  return `${String(title || "").trim()}\n\n${String(body || "").trim()}\n\n${episodeUrl}\n\nTags: ${tags.join(", ")}\n`;
}

// No LLM key still produces usable posts from the episode data alone.
function buildFallbackDrafts(episode) {
  const hooks = (episode.clipHooks || [])
    .slice(0, 3)
    .map((hook) => hook.title)
    .filter(Boolean);
  const hookText = hooks.length ? ` This week: ${hooks.join(", ")}.` : "";
  return {
    bluesky: `New episode! 🌾 ${episode.title} — ${episode.description}`.slice(
      0,
      BLUESKY_BODY_LIMIT,
    ),
    tumblrTitle: `New episode: ${episode.title}`,
    tumblrBody: `${episode.description}${hookText}`,
  };
}

async function generateSocialPosts({ episode, llm, complete = completeJson }) {
  let drafts;
  if (llm) {
    const prompt = [
      `Episode title: ${episode.title}`,
      `Description: ${episode.description}`,
      `Chapters: ${(episode.chapters || []).join(", ")}`,
      "",
      "The episode's best moments (from clip selection):",
      ...(episode.clipHooks || []).map(
        (hook) => `- ${hook.title}${hook.caption ? ` — ${hook.caption}` : ""}`,
      ),
    ].join("\n");

    drafts = await complete({
      llm,
      system: SYSTEM_PROMPT,
      prompt,
      schema: SOCIAL_SCHEMA,
    });
  } else {
    drafts = buildFallbackDrafts(episode);
  }

  const bluesky = composeBlueskyPost(drafts.bluesky, episode.episodeUrl);
  const tumblr = composeTumblrPost({
    title: drafts.tumblrTitle,
    body: drafts.tumblrBody,
    episodeUrl: episode.episodeUrl,
    mainTopic: episode.mainTopic,
  });

  return {
    bluesky,
    tumblr,
    blueskyLength: bluesky.trim().length,
    blueskyOverLimit: bluesky.trim().length > 300,
  };
}

// Same shape as the other LLM caches: repeated clicks are free until the episode's
// material actually changes.
async function generateSocialPostsCached({ cacheDir, ...options }) {
  const cacheKey = crypto
    .createHash("sha1")
    .update(
      `${SOCIAL_PROMPT_VERSION}:${options.llm ? `${options.llm.provider}:${options.llm.model}` : "fallback"}:${JSON.stringify(options.episode)}`,
    )
    .digest("hex");
  const cachePath = cacheDir ? path.join(cacheDir, `${cacheKey}.json`) : null;

  if (cachePath && fileExists(cachePath)) {
    const cached = readJson(cachePath, false);
    if (cached) {
      return { ...cached, fromCache: true };
    }
  }

  const result = await generateSocialPosts(options);
  if (cachePath) {
    writeJson(cachePath, result);
  }
  return { ...result, fromCache: false };
}

module.exports = {
  composeBlueskyPost,
  composeTumblrPost,
  generateSocialPosts,
  generateSocialPostsCached,
};
