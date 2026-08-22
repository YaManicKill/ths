// Converts an episode's finished index.md - description, timings, links, contact -
// into a paste-ready YouTube description. Reads the file as it exists NOW, so it runs
// after the shownotes are complete (custom links included) rather than at generation
// time; YouTube turns the timestamp lines into native video chapters.

const { REQUIRED_CLIP_HASHTAGS } = require("./clip-suggestions-llm");

// The show's platform links come from the site's own config.toml, so there is one
// source of truth and nothing to keep in sync by hand. The values are simple
// key = "value" lines; a targeted extractor beats a TOML dependency here.
const PLATFORM_LABELS = [
  ["applepodcasts", "Apple Podcasts"],
  ["spotify", "Spotify"],
  ["pocketcasts", "Pocket Casts"],
  ["overcast", "Overcast"],
];

function readShowLinksFromConfig(configTomlText) {
  const text = String(configTomlText || "");
  const value = (key) => {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m").exec(text);
    return match ? match[1] : null;
  };

  const listenLinks = PLATFORM_LABELS.map(([key, label]) => {
    const url = value(key);
    return url ? `${label} - ${url}` : null;
  }).filter(Boolean);

  const patreon = /identifier\s*=\s*"patreon"[\s\S]*?url\s*=\s*"([^"]+)"/.exec(
    text,
  );

  return {
    listenLinks,
    patreonUrl: patreon ? patreon[1] : null,
    baseUrl: value("baseURL"),
  };
}

function parseFrontmatterDescription(indexMdText) {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(indexMdText);
  if (!frontmatter) {
    return "";
  }
  const match = /^Description:\s*"?([^"\n]+)"?$/m.exec(frontmatter[1]);
  return match ? match[1].trim() : "";
}

function sectionLines(indexMdText, heading) {
  const pattern = new RegExp(
    `(?:^|\\n)## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`,
  );
  const match = pattern.exec(indexMdText);
  if (!match) {
    return [];
  }
  return match[1].split("\n").map((line) => line.trim());
}

// YouTube chapter lines: first at 0:00, ascending, "m:ss Title" (hours only when
// needed). index.md timings are "HH:MM:SS: Title".
function formatChapterLines(indexMdText) {
  const lines = [];
  for (const line of sectionLines(indexMdText, "Timings")) {
    const match = /^(\d{2}):(\d{2}):(\d{2}): (.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = match[3];
    const stamp =
      hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
        : `${minutes}:${seconds}`;
    lines.push(`${stamp} ${match[4]}`);
  }
  return lines;
}

// Markdown links become "Title - url" (YouTube auto-links bare URLs); bare title
// lines and blank group separators pass through.
function formatLinkLines(indexMdText) {
  const lines = [];
  for (const line of sectionLines(indexMdText, "Links")) {
    const link = /^\[(.*)\]\((.+)\)$/.exec(line);
    if (link) {
      lines.push(link[1] ? `${link[1]} - ${link[2]}` : link[2]);
    } else if (line !== "[]()") {
      lines.push(line);
    }
  }
  while (lines[0] === "") {
    lines.shift();
  }
  while (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function buildYoutubeDescription({ indexMdText, episodeUrl, showLinks }) {
  const text = String(indexMdText || "");
  const parts = [];

  const description = parseFrontmatterDescription(text);
  if (description) {
    parts.push(description);
  }

  if (episodeUrl) {
    parts.push(`Full shownotes: ${episodeUrl}`);
  }

  const chapters = formatChapterLines(text);
  if (chapters.length > 0) {
    parts.push(["Chapters:", ...chapters].join("\n"));
  }

  const links = formatLinkLines(text);
  if (links.length > 0) {
    parts.push(["Links:", ...links].join("\n"));
  }

  if (showLinks?.listenLinks?.length) {
    parts.push(["Listen to the podcast:", ...showLinks.listenLinks].join("\n"));
  }
  if (showLinks?.patreonUrl) {
    parts.push(`Support us on Patreon - ${showLinks.patreonUrl}`);
  }

  const contact = sectionLines(text, "Contact").filter(Boolean);
  if (contact.length > 0) {
    parts.push(contact.join("\n"));
  }

  parts.push(REQUIRED_CLIP_HASHTAGS.join(" "));

  return `${parts.join("\n\n")}\n`;
}

module.exports = {
  buildYoutubeDescription,
  parseFrontmatterDescription,
  readShowLinksFromConfig,
};
