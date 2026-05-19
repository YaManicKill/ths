const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ensureDir, fileExists, normalizeTitle } = require("./utils");

async function fetchWithTimeout(url, timeoutMs = 8000, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "user-agent": "ths-postprocess-bot/1.0",
        ...(options.headers || {}),
      },
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function pickFileExtensionFromUrl(url) {
  const match = String(url).match(/\.([a-z0-9]+)(?:\?|#|$)/i);
  if (!match) {
    return "jpg";
  }

  const ext = match[1].toLowerCase();
  if (["jpg", "jpeg", "png", "webp"].includes(ext)) {
    return ext === "jpeg" ? "jpg" : ext;
  }

  return "jpg";
}

async function downloadImage(url, cacheDir, cacheKey) {
  ensureDir(cacheDir);
  const ext = pickFileExtensionFromUrl(url);
  const hash = crypto
    .createHash("sha1")
    .update(cacheKey || url)
    .digest("hex")
    .slice(0, 16);
  const outPath = path.join(cacheDir, `${hash}.${ext}`);

  if (fileExists(outPath)) {
    return outPath;
  }

  const response = await fetchWithTimeout(url, 12000);
  if (!response.ok) {
    throw new Error(
      `Failed to download image (${response.status}) from ${url}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(outPath, Buffer.from(arrayBuffer));
  return outPath;
}

function resolveOverrideValue(overrideValue, repoRoot) {
  if (!overrideValue) {
    return null;
  }

  if (/^https?:\/\//i.test(overrideValue)) {
    return { type: "url", value: overrideValue };
  }

  const resolved = path.isAbsolute(overrideValue)
    ? overrideValue
    : path.join(repoRoot, overrideValue);

  if (!fileExists(resolved)) {
    return null;
  }

  return { type: "file", value: resolved };
}

async function resolveChapterImages(chapters, options) {
  const {
    cacheDir,
    fallbackImagePath,
    repoRoot,
    persistentOverrides = {},
  } = options;

  ensureDir(cacheDir);

  const results = [];

  for (const chapter of chapters) {
    const normalized = normalizeTitle(chapter.title);

    // Skip image lookups for Theme Tune, Intro and Outro - use fallback only
    if (
      normalized === "theme tune" ||
      normalized === "intro" ||
      normalized === "outro"
    ) {
      results.push({
        ...chapter,
        imagePath: fallbackImagePath,
        defaultImagePath: fallbackImagePath,
        imageSource: "fallback:skipped-theme-tune-intro-outro",
      });
      continue;
    }

    const overrideValue = persistentOverrides[normalized];

    if (overrideValue) {
      const resolved = resolveOverrideValue(overrideValue, repoRoot);
      if (resolved) {
        if (resolved.type === "file") {
          results.push({
            ...chapter,
            imagePath: resolved.value,
            defaultImagePath: fallbackImagePath,
            imageSource: "override:file",
          });
          continue;
        }

        if (resolved.type === "url") {
          try {
            const imagePath = await downloadImage(
              resolved.value,
              cacheDir,
              `${normalized}:override`,
            );
            results.push({
              ...chapter,
              imagePath,
              defaultImagePath: fallbackImagePath,
              imageSource: "override:url",
            });
            continue;
          } catch {
            // Fall back when an override URL cannot be downloaded.
          }
        }
      }
    }

    results.push({
      ...chapter,
      imagePath: fallbackImagePath,
      defaultImagePath: fallbackImagePath,
      imageSource: "fallback:mp3-cover",
    });
  }

  return results;
}

module.exports = {
  resolveChapterImages,
};
