const fs = require("node:fs");
const path = require("node:path");

// Rough average glyph advance as a fraction of font size for a mixed-case humanist sans.
// drawtext cannot wrap, so lines must be broken before ffmpeg sees them, which means
// estimating width without access to the font's real metrics.
const AVERAGE_GLYPH_WIDTH_RATIO = 0.52;

const FONT_CANDIDATES = {
  darwin: [
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
  ],
  linux: [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  ],
  win32: ["C:\\Windows\\Fonts\\arial.ttf", "C:\\Windows\\Fonts\\segoeui.ttf"],
};

// drawtext only renders a .ttc's first face, so bold needs its own font file.
const BOLD_FONT_CANDIDATES = {
  darwin: [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
  ],
  linux: [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
  ],
  win32: [
    "C:\\Windows\\Fonts\\arialbd.ttf",
    "C:\\Windows\\Fonts\\segoeuib.ttf",
  ],
};

const cachedFontPaths = {};

function fontCandidatesForPlatform(platform = process.platform) {
  return FONT_CANDIDATES[platform] || FONT_CANDIDATES.linux;
}

function boldFontCandidatesForPlatform(platform = process.platform) {
  return BOLD_FONT_CANDIDATES[platform] || BOLD_FONT_CANDIDATES.linux;
}

function resolveClipFontPath(options = {}) {
  const injected = Boolean(options.platform || options.exists);
  if (cachedFontPaths.regular && !injected) {
    return cachedFontPaths.regular;
  }

  const platform = options.platform || process.platform;
  const fileExists = options.exists || ((file) => fs.existsSync(file));
  const candidates = fontCandidatesForPlatform(platform);
  const found = candidates.find((candidate) => fileExists(candidate));

  if (!found) {
    throw new Error(
      `No usable font found for clip labels on ${platform}. Tried:\n  ${candidates.join("\n  ")}`,
    );
  }

  if (!injected) {
    cachedFontPaths.regular = found;
  }
  return found;
}

// A bold face is preferred for the title but never required: a machine without one
// renders the title in the regular face rather than failing the whole clip run.
function resolveClipBoldFontPath(options = {}) {
  const injected = Boolean(options.platform || options.exists);
  if (cachedFontPaths.bold && !injected) {
    return cachedFontPaths.bold;
  }

  const platform = options.platform || process.platform;
  const fileExists = options.exists || ((file) => fs.existsSync(file));
  const found =
    boldFontCandidatesForPlatform(platform).find((candidate) =>
      fileExists(candidate),
    ) || resolveClipFontPath(options);

  if (!injected) {
    cachedFontPaths.bold = found;
  }
  return found;
}

function charactersPerLine({
  maxWidthPx,
  fontSize,
  glyphWidthRatio = AVERAGE_GLYPH_WIDTH_RATIO,
}) {
  const perCharacter = Math.max(1, fontSize * glyphWidthRatio);
  return Math.max(8, Math.floor(maxWidthPx / perCharacter));
}

function splitOverlongWord(word, limit) {
  const pieces = [];
  for (let start = 0; start < word.length; start += limit) {
    pieces.push(word.slice(start, start + limit));
  }
  return pieces;
}

function wrapLabelText({
  text,
  maxWidthPx = 960,
  fontSize = 52,
  maxLines = 3,
  glyphWidthRatio,
}) {
  const limit = charactersPerLine({ maxWidthPx, fontSize, glyphWidthRatio });
  const words = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .flatMap((word) =>
      word.length > limit ? splitOverlongWord(word, limit) : [word],
    );

  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
    }
    current = word;
  }

  if (current) {
    lines.push(current);
  }

  if (lines.length <= maxLines) {
    return lines;
  }

  const kept = lines.slice(0, maxLines);
  kept[kept.length - 1] = `${kept[kept.length - 1]}…`;
  return kept;
}

// "2026-08-19T19:00:00+01:00" -> "19 August 2026". Works from the string's date part so
// the displayed day can never shift across a timezone conversion.
function formatEpisodeDateForOverlay(dateString) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(
    String(dateString || "").trim(),
  );
  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
  const formatted = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))));

  return formatted;
}

// drawtext's inline text= needs colons, commas, quotes and backslashes escaped, which is
// easy to get wrong for arbitrary transcript text. A file avoids the escaping entirely and
// gives multi-line rendering for free.
function writeLabelTextFile({ lines, workDir, name = "label" }) {
  fs.mkdirSync(workDir, { recursive: true });
  const filePath = path.join(workDir, `${name}.txt`);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

module.exports = {
  AVERAGE_GLYPH_WIDTH_RATIO,
  boldFontCandidatesForPlatform,
  charactersPerLine,
  fontCandidatesForPlatform,
  formatEpisodeDateForOverlay,
  resolveClipBoldFontPath,
  resolveClipFontPath,
  wrapLabelText,
  writeLabelTextFile,
};
