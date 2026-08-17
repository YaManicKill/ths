const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { runPipeline, discoverEpisodeData } = require("../pipeline");
const {
  applyTranscriptFixes,
  quoteOccursIn,
  reviewTranscriptCached,
  selectTranscriptFixes,
} = require("../transcript-review");
const { resolveLlm } = require("../llm");
const { buildClipSuggestions } = require("../clip-suggestions");
const { suggestClipsLlmCached } = require("../clip-suggestions-llm");
const { stripSpeakerPrefix } = require("../clip-subtitles");
const { parseVttCues } = require("../vtt");
const { generateClipVideos, generateVideoFromChapters } = require("../video");
const { loadPostprocessConfig } = require("../config");
const {
  chapterImageOverridesPath,
  computeWaveformPeaks,
  normalizeTitle,
  parseByteRange,
  readJson,
  runCommand,
  writeJson,
} = require("../utils");

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 100);
}

function parseDataUrl(dataUrl) {
  const match =
    /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(
      String(dataUrl || ""),
    );
  if (!match) {
    throw new Error("Invalid image data");
  }

  const mimeType = match[1].toLowerCase();
  const base64Data = match[2].replace(/\s+/g, "");
  const buffer = Buffer.from(base64Data, "base64");
  if (buffer.length === 0) {
    throw new Error("Uploaded image is empty");
  }

  let extension = ".jpg";
  if (mimeType.includes("png")) {
    extension = ".png";
  } else if (mimeType.includes("webp")) {
    extension = ".webp";
  }

  return { buffer, extension };
}

function extensionFromMimeType(mimeType, fallback = ".jpg") {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("png")) {
    return ".png";
  }
  if (normalized.includes("webp")) {
    return ".webp";
  }
  if (normalized.includes("gif")) {
    return ".gif";
  }
  if (normalized.includes("jpeg") || normalized.includes("jpg")) {
    return ".jpg";
  }
  return fallback;
}

function extensionFromUrl(imageUrl) {
  try {
    const parsed = new URL(imageUrl);
    const ext = path.extname(parsed.pathname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) {
      return ext === ".jpeg" ? ".jpg" : ext;
    }
  } catch {
    return ".jpg";
  }
  return ".jpg";
}

function letterboxImageBufferToSquare(buffer, extension = ".png") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ths-postprocess-"));
  const inputPath = path.join(tempDir, `input${extension || ".png"}`);
  const outputPath = path.join(tempDir, "output.png");

  try {
    fs.writeFileSync(inputPath, buffer);

    const result = runCommand("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-vf",
      "pad=max(iw\\,ih):max(iw\\,ih):(ow-iw)/2:(oh-ih)/2:color=black",
      "-frames:v",
      "1",
      outputPath,
    ]);

    if (result.status !== 0) {
      throw new Error(
        result.stderr || result.stdout || "Failed to letterbox image",
      );
    }

    return {
      buffer: fs.readFileSync(outputPath),
      extension: ".png",
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function resolveUrlMaybeRelative(baseUrl, value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractImageUrlFromHtml(html, baseUrl) {
  const text = String(html || "");
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["'][^>]*>/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["'][^>]*>/i,
    /<img[^>]+src=["']([^"']+)["'][^>]*>/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match[1]) {
      const resolved = resolveUrlMaybeRelative(baseUrl, match[1]);
      if (resolved && /^https?:\/\//i.test(resolved)) {
        return resolved;
      }
    }
  }

  return null;
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

async function fetchPageTitle(pageUrl) {
  let parsed;
  try {
    parsed = new URL(pageUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) URLs are supported");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "accept-language": "en-GB,en;q=0.9",
      },
    });
    if (!response.ok) {
      throw new Error(`Page fetch failed (${response.status})`);
    }
    const html = await response.text();
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const title = match
      ? decodeHtmlEntities(match[1]).replace(/\s+/g, " ").trim()
      : "";
    if (!title) {
      throw new Error("Page has no title");
    }
    return title;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Page fetch timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function downloadImageFromUrl(imageUrl) {
  let parsed;
  try {
    parsed = new URL(String(imageUrl || "").trim());
  } catch {
    throw new Error("Invalid image URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) image URLs are supported");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20_000);

  try {
    const browserHeaders = {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      "accept-language": "en-GB,en;q=0.9,en-US;q=0.8",
      referer: `${parsed.origin}/`,
    };

    let response = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: browserHeaders,
    });

    if (response.status === 403) {
      // Retry once without referer since some CDNs block unexpected referers.
      response = await fetch(parsed.toString(), {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "user-agent": browserHeaders["user-agent"],
          accept: browserHeaders.accept,
          "accept-language": browserHeaders["accept-language"],
        },
      });
    }

    if (!response.ok) {
      throw new Error(
        `Failed to fetch image URL (${response.status}) - host blocked remote download`,
      );
    }

    let mimeType = String(response.headers.get("content-type") || "");
    if (!mimeType.toLowerCase().startsWith("image/")) {
      const isHtml = mimeType.toLowerCase().includes("text/html");
      if (!isHtml) {
        throw new Error("Dropped URL did not return an image");
      }

      const html = await response.text();
      const extractedImageUrl = extractImageUrlFromHtml(
        html,
        parsed.toString(),
      );
      if (!extractedImageUrl) {
        throw new Error("Dropped page URL did not contain an image we can use");
      }

      response = await fetch(extractedImageUrl, {
        signal: controller.signal,
        redirect: "follow",
        headers: browserHeaders,
      });

      if (!response.ok) {
        throw new Error(
          `Found page image URL but failed to fetch it (${response.status})`,
        );
      }

      mimeType = String(response.headers.get("content-type") || "");
      if (!mimeType.toLowerCase().startsWith("image/")) {
        throw new Error("Found page image URL but it did not return an image");
      }
    }

    const contentLength = Number(response.headers.get("content-length") || "0");
    if (Number.isFinite(contentLength) && contentLength > 15 * 1024 * 1024) {
      throw new Error("Image too large (max 15MB)");
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length === 0) {
      throw new Error("Downloaded image is empty");
    }
    if (buffer.length > 15 * 1024 * 1024) {
      throw new Error("Image too large (max 15MB)");
    }

    const extension = extensionFromMimeType(
      mimeType,
      extensionFromUrl(parsed.toString()),
    );
    return { buffer, extension };
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("Timed out downloading image URL");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Status endpoints are polled on the same URL; never let a response be reused.
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload, null, 2));
}

function readRequestBody(req, { maxBytes = 2_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;
    req.on("data", (chunk) => {
      totalLength += chunk.length;
      if (totalLength > maxBytes) {
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveStaticFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.end("Not Found");
  }
}

const SERVABLE_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

function isServableImagePath(filePath) {
  return SERVABLE_IMAGE_EXTENSIONS.includes(
    path.extname(filePath).toLowerCase(),
  );
}

function contentTypeForImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  return "image/jpeg";
}

function toRepoRelativePath(repoRoot, filePath) {
  const relative = path.relative(repoRoot, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative.split(path.sep).join("/");
}

function resolvePreferredClipImagePath({ resolvedMp3Path, resolvedImagePath }) {
  const episodeDir = path.dirname(resolvedMp3Path);
  const episodesRoot = path.dirname(episodeDir);
  const projectRoot = path.dirname(episodesRoot);
  const assetsDir = path.join(projectRoot, "Assets");

  const candidates = [
    "HarvestSeason-FullLogo-FullColor-01.png",
    "HarvestSeason-Final-PodcastArt-01.png",
    "logo.png",
    "thumbnail.png",
  ].map((name) => path.join(assetsDir, name));

  for (const candidatePath of candidates) {
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return resolvedImagePath;
}

// Newline-delimited JSON over a chunked response: {type:"progress"} events while the
// work runs, then exactly one {type:"result"} or {type:"error"} to finish. The stream
// stays open for minutes, so a client that reloads or disconnects mid-run is normal -
// writes after that are dropped, and the response's error event must have a listener
// or the EPIPE would crash the whole server process.
function startNdjsonStream(res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-store");
  res.flushHeaders?.();
  res.on("error", () => {});
  const write = (line) => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(`${line}\n`);
    }
  };
  const end = (line) => {
    if (!res.writableEnded && !res.destroyed) {
      res.end(`${line}\n`);
    }
  };
  return {
    progress: (message) => {
      write(JSON.stringify({ type: "progress", message }));
    },
    result: (payload) => {
      end(JSON.stringify({ type: "result", ...payload }));
    },
    error: (message) => {
      end(JSON.stringify({ type: "error", error: message }));
    },
  };
}

function deriveEpisodeOutputPaths({ repoRoot, discovered, mp3Path }) {
  const outputRoot = loadPostprocessConfig(repoRoot).outputRoot;

  const episodeFolderName = `${String(discovered.episodeMeta.seasonCode)}-${String(discovered.episodeMeta.episodeCode)}-${slugify(discovered.episodeTitle)}`;
  const episodeDir = path.join(
    repoRoot,
    outputRoot,
    `year${String(discovered.seasonInfo.year)}`,
    String(discovered.seasonInfo.folder || ""),
    episodeFolderName,
  );
  const videoStatusFile = path.join(episodeDir, "video-status.json");
  const videoPath = path.join(
    path.dirname(mp3Path),
    `ths-${String(discovered.episodeMeta.seasonCode)}-${String(discovered.episodeMeta.episodeCode)}.mp4`,
  );

  return {
    episodeDir,
    videoStatusFile,
    videoPath,
  };
}

function startServer({ port = 4173, onPortConflict } = {}) {
  const publicDir = path.join(__dirname, "public");
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const manualImageDir = path.join(
    repoRoot,
    ".cache",
    "postprocess",
    "manual-images",
  );
  const chapterOverridesPath = chapterImageOverridesPath(repoRoot);
  const activeVideoStatusFiles = new Set();
  const activeClipGenerationStatusFiles = new Set();
  const clipGenerationAbortControllers = new Map();

  function saveChapterOverride(chapterTitle, filePath) {
    const key = normalizeTitle(chapterTitle);
    if (!key) {
      return;
    }
    const overrides = readJson(chapterOverridesPath, {});
    overrides[key] = toRepoRelativePath(repoRoot, filePath);
    writeJson(chapterOverridesPath, overrides);
  }

  function clearChapterOverride(chapterTitle) {
    const key = normalizeTitle(chapterTitle);
    if (!key) {
      return false;
    }
    const overrides = readJson(chapterOverridesPath, {});
    if (!(key in overrides)) {
      return false;
    }
    delete overrides[key];
    writeJson(chapterOverridesPath, overrides);
    return true;
  }

  function markVideoStatusInterrupted(statusFile, statusData = {}) {
    const interrupted = {
      ...statusData,
      status: "failed",
      failedAt: new Date().toISOString(),
      error:
        statusData.error ||
        "Video generation was interrupted (server process restarted or exited)",
    };
    writeJson(statusFile, interrupted);
    activeVideoStatusFiles.delete(statusFile);
    return interrupted;
  }

  function markClipGenerationInterrupted(statusFile, clipStatus = {}) {
    const existing = readJson(statusFile, { status: "unknown" });
    existing.clipGeneration = {
      ...clipStatus,
      status: "failed",
      failedAt: new Date().toISOString(),
      error:
        clipStatus.error ||
        "Clip generation was interrupted (server process restarted or exited)",
    };
    writeJson(statusFile, existing);
    activeClipGenerationStatusFiles.delete(statusFile);
    return existing.clipGeneration;
  }

  function writeVideoStatusPreserveClipGeneration(statusFile, nextStatus) {
    const existing = readJson(statusFile, {});
    if (existing.clipGeneration && nextStatus.clipGeneration === undefined) {
      nextStatus.clipGeneration = existing.clipGeneration;
    }
    writeJson(statusFile, nextStatus);
  }

  function updateClipGenerationStatus(statusFile, patch) {
    const existing = readJson(statusFile, { status: "unknown" });
    existing.clipGeneration = {
      ...(existing.clipGeneration || {}),
      ...patch,
    };
    writeJson(statusFile, existing);
    return existing.clipGeneration;
  }

  async function waitForVideoCompletion(statusFile, signal) {
    for (;;) {
      if (signal?.aborted) {
        const error = new Error("Clip generation cancelled");
        error.name = "AbortError";
        throw error;
      }
      const current = readNormalizedVideoStatus(statusFile);
      if (current.status === "completed" || current.status === "skipped") {
        return current;
      }
      if (current.status === "failed") {
        throw new Error(current.error || "MP4 generation failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  function buildClipGenerationState({
    status,
    total,
    current = 0,
    percent,
    outputs = [],
    error,
    waitingForVideo = false,
  }) {
    const safeTotal = Math.max(0, Number(total || 0));
    const safeCurrent = Math.max(0, Number(current || 0));
    // Time-weighted percent from the renderer when available; clip count otherwise.
    const safePercent = Number.isFinite(Number(percent))
      ? Math.max(0, Math.min(100, Math.round(Number(percent))))
      : safeTotal > 0
        ? Math.round((safeCurrent / safeTotal) * 100)
        : 0;
    return {
      status,
      total: safeTotal,
      current: safeCurrent,
      remaining: Math.max(0, safeTotal - safeCurrent),
      percent: safePercent,
      outputs,
      waitingForVideo,
      ...(error ? { error } : {}),
    };
  }

  async function startQueuedClipGeneration({
    statusFile,
    clipSuggestions,
    preferredClipImagePath,
    resolvedMp3Path,
    episodeTitle,
    episodeDateString,
    transcriptVttText,
  }) {
    activeClipGenerationStatusFiles.add(statusFile);
    const abortController = new AbortController();
    clipGenerationAbortControllers.set(statusFile, abortController);

    const total = clipSuggestions.length;
    const initialVideoStatus = readNormalizedVideoStatus(statusFile);
    const shouldWaitForVideo = initialVideoStatus.status === "started";

    updateClipGenerationStatus(
      statusFile,
      buildClipGenerationState({
        status: shouldWaitForVideo ? "waiting" : "started",
        total,
        current: 0,
        outputs: [],
        waitingForVideo: shouldWaitForVideo,
        startedAt: new Date().toISOString(),
      }),
    );

    setImmediate(async () => {
      const clipBaseDirectory = path.dirname(resolvedMp3Path);
      const clipOutputDir = path.join(clipBaseDirectory, "clip-videos");
      // The renderer reports through onProgress, including mid-render; remembered here
      // so a failure can still say how far the run got.
      let lastProgress = { current: 0, percent: 0 };

      try {
        if (shouldWaitForVideo) {
          await waitForVideoCompletion(statusFile, abortController.signal);
          updateClipGenerationStatus(
            statusFile,
            buildClipGenerationState({
              status: "started",
              total,
              current: 0,
              outputs: [],
              waitingForVideo: false,
            }),
          );
        }

        const outputs = await generateClipVideos({
          clipSuggestions,
          imagePath: preferredClipImagePath,
          mp3Path: resolvedMp3Path,
          outputDir: clipOutputDir,
          workDir: path.join(clipOutputDir, ".work"),
          episodeTitle,
          episodeDateString,
          transcriptVttText,
          signal: abortController.signal,
          onProgress: (progress) => {
            lastProgress = progress;
            updateClipGenerationStatus(
              statusFile,
              buildClipGenerationState({
                status: "started",
                total: progress.total,
                current: progress.current,
                percent: progress.percent,
                outputs: [],
                waitingForVideo: false,
              }),
            );
          },
        });

        updateClipGenerationStatus(statusFile, {
          ...buildClipGenerationState({
            status: "completed",
            total,
            current: total,
            outputs,
            waitingForVideo: false,
          }),
          completedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (abortController.signal.aborted) {
          updateClipGenerationStatus(statusFile, {
            ...buildClipGenerationState({
              status: "cancelled",
              total,
              current: lastProgress.current,
              percent: lastProgress.percent,
              outputs: [],
              waitingForVideo: false,
            }),
            cancelledAt: new Date().toISOString(),
          });
        } else {
          updateClipGenerationStatus(statusFile, {
            ...buildClipGenerationState({
              status: "failed",
              total,
              current: lastProgress.current,
              percent: lastProgress.percent,
              outputs: [],
              waitingForVideo: false,
              error: error.message,
            }),
            failedAt: new Date().toISOString(),
          });
        }
      } finally {
        activeClipGenerationStatusFiles.delete(statusFile);
        clipGenerationAbortControllers.delete(statusFile);
      }
    });
  }

  function readNormalizedVideoStatus(statusFile) {
    if (!fs.existsSync(statusFile)) {
      return {
        statusFile,
        status: "missing",
      };
    }

    const parsed = readJson(statusFile, { status: "unknown" });
    if (
      parsed.status === "started" &&
      !activeVideoStatusFiles.has(statusFile)
    ) {
      const interrupted = markVideoStatusInterrupted(statusFile, parsed);
      return {
        statusFile,
        ...interrupted,
      };
    }

    if (
      parsed.clipGeneration &&
      ["started", "waiting"].includes(parsed.clipGeneration.status) &&
      !activeClipGenerationStatusFiles.has(statusFile)
    ) {
      parsed.clipGeneration = markClipGenerationInterrupted(
        statusFile,
        parsed.clipGeneration,
      );
    }

    if (
      parsed.status === "completed" ||
      parsed.status === "failed" ||
      parsed.status === "skipped"
    ) {
      activeVideoStatusFiles.delete(statusFile);
    }

    return {
      statusFile,
      ...parsed,
    };
  }

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end("Bad Request");
      return;
    }

    const parsedUrl = new URL(req.url, `http://localhost:${port}`);
    const pathname = parsedUrl.pathname;

    if (req.method === "GET" && pathname === "/") {
      serveStaticFile(
        res,
        path.join(publicDir, "index.html"),
        "text/html; charset=utf-8",
      );
      return;
    }

    if (req.method === "GET" && pathname === "/app.js") {
      serveStaticFile(
        res,
        path.join(publicDir, "app.js"),
        "application/javascript; charset=utf-8",
      );
      return;
    }

    if (req.method === "GET" && pathname === "/styles.css") {
      serveStaticFile(
        res,
        path.join(publicDir, "styles.css"),
        "text/css; charset=utf-8",
      );
      return;
    }

    if (req.method === "GET" && pathname === "/api/image") {
      const imagePath = parsedUrl.searchParams.get("path");
      if (
        !imagePath ||
        !path.isAbsolute(imagePath) ||
        !isServableImagePath(imagePath)
      ) {
        res.statusCode = 400;
        res.end("Bad image path");
        return;
      }

      try {
        const stat = fs.statSync(imagePath);
        if (!stat.isFile()) {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", contentTypeForImage(imagePath));
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        fs.createReadStream(imagePath).pipe(res);
      } catch {
        res.statusCode = 404;
        res.end("Not Found");
      }
      return;
    }

    // Streams the episode MP3 with Range support so the browser can seek straight to a
    // clip's start time for in-card preview, without any pre-generated audio files.
    if (req.method === "GET" && pathname === "/api/audio") {
      const audioPath = parsedUrl.searchParams.get("path");
      if (
        !audioPath ||
        !path.isAbsolute(audioPath) ||
        path.extname(audioPath).toLowerCase() !== ".mp3"
      ) {
        res.statusCode = 400;
        res.end("Bad audio path");
        return;
      }

      try {
        const stat = fs.statSync(audioPath);
        if (!stat.isFile()) {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }

        const range = parseByteRange(req.headers.range, stat.size);
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

        if (range === "unsatisfiable") {
          res.statusCode = 416;
          res.setHeader("Content-Range", `bytes */${stat.size}`);
          res.end();
          return;
        }

        if (range) {
          res.statusCode = 206;
          res.setHeader(
            "Content-Range",
            `bytes ${range.start}-${range.end}/${stat.size}`,
          );
          res.setHeader("Content-Length", range.end - range.start + 1);
          fs.createReadStream(audioPath, {
            start: range.start,
            end: range.end,
          }).pipe(res);
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Length", stat.size);
        fs.createReadStream(audioPath).pipe(res);
      } catch {
        res.statusCode = 404;
        res.end("Not Found");
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/discover") {
      const body = await readRequestBody(req);
      // Streamed NDJSON: progress events go out the moment each pipeline step starts,
      // instead of arriving as a lump when the whole request finishes.
      const stream = startNdjsonStream(res);
      try {
        const payload = JSON.parse(body || "{}");

        const discovered = await discoverEpisodeData({
          mp3Path: payload.mp3Path,
          transcriptMdPath: payload.transcriptMdPath,
          transcriptVttPath: payload.transcriptVttPath,
          episodeTitle: payload.episodeTitle,
          description: payload.description,
          publishDate: payload.publishDate,
          onProgress: stream.progress,
        });

        const { videoStatusFile: derivedVideoStatusFile } =
          deriveEpisodeOutputPaths({
            repoRoot,
            discovered,
            mp3Path: payload.mp3Path,
          });
        const discoveredVideoStatus = readNormalizedVideoStatus(
          derivedVideoStatusFile,
        );

        // Clip suggestions from a previous run/regenerate, so the cards (and the
        // generate button) come back after a page refresh instead of requiring a
        // fresh - and differently-picked - regeneration.
        const episodeReportPath = path.join(
          path.dirname(derivedVideoStatusFile),
          "postprocess-report.json",
        );
        const episodeReport = fs.existsSync(episodeReportPath)
          ? readJson(episodeReportPath, {})
          : null;

        // Medium-confidence review findings come back too, minus any whose quote no
        // longer appears in the episode transcript - those were applied (or hand-
        // fixed) and would only offer a fix that cannot land.
        const episodeMdPath = path.join(
          path.dirname(derivedVideoStatusFile),
          "transcript.md",
        );
        const episodeMdText =
          episodeReport && fs.existsSync(episodeMdPath)
            ? fs.readFileSync(episodeMdPath, "utf8")
            : null;
        const existingTranscriptFindings =
          episodeMdText &&
          Array.isArray(episodeReport?.transcriptReview?.findings)
            ? episodeReport.transcriptReview.findings.filter(
                (finding) =>
                  finding.confidence !== "high" &&
                  quoteOccursIn(episodeMdText, finding.quote),
              )
            : [];

        stream.result({
          success: true,
          discovered: {
            episodeTitle: discovered.episodeTitle,
            episodeMeta: discovered.episodeMeta,
            seasonInfo: discovered.seasonInfo,
            description: discovered.description,
            dateString: discovered.dateString,
            clipSuggestions: discovered.clipSuggestions,
            chapters: discovered.chapters.map((ch) => ({
              timeLabel: ch.timeLabel,
              title: ch.title,
              durationSeconds: ch.durationSeconds,
              imageSource: ch.imageSource,
              imagePath: ch.imagePath,
              defaultImagePath: ch.defaultImagePath,
            })),
            hiddenLinkTitles: discovered.hiddenLinkTitles,
            transcriptChecks: {
              totalMatches:
                discovered.profanityMatches.transcriptMd.length +
                discovered.profanityMatches.transcriptVtt.length,
              transcriptMd: discovered.profanityMatches.transcriptMd,
              transcriptVtt: discovered.profanityMatches.transcriptVtt,
            },
            audioQc: discovered.audioQc,
            videoStatus: discoveredVideoStatus,
            existingClipSuggestions: Array.isArray(
              episodeReport?.clipSuggestions,
            )
              ? episodeReport.clipSuggestions
              : [],
            existingTranscriptFindings,
            shownotesLinkSeeds:
              discovered.shownotesLinkSeeds || discovered.hiddenLinks,
            existingShownotesLinks: Array.isArray(episodeReport?.shownotesLinks)
              ? episodeReport.shownotesLinks
              : null,
          },
          discoveryData: JSON.stringify(discovered),
        });
      } catch (error) {
        stream.error(error.message);
      }
      return;
    }

    // Title lookup for a pasted shownotes URL, so the user edits a sensible default
    // instead of typing every title from scratch.
    if (req.method === "POST" && pathname === "/api/fetch-link-title") {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || "{}");
        const title = await fetchPageTitle(String(payload.url || "").trim());
        sendJson(res, 200, { success: true, title });
      } catch (error) {
        sendJson(res, 400, { success: false, error: error.message });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/upload-chapter-image") {
      try {
        const body = await readRequestBody(req, { maxBytes: 30 * 1024 * 1024 });
        const payload = JSON.parse(body || "{}");

        const chapterTitle = String(payload.chapterTitle || "").trim();
        if (!chapterTitle) {
          sendJson(res, 400, { success: false, error: "Missing chapterTitle" });
          return;
        }

        let imageData;
        if (payload.imageUrl) {
          imageData = await downloadImageFromUrl(payload.imageUrl);
        } else {
          imageData = parseDataUrl(payload.dataUrl);
        }

        imageData = letterboxImageBufferToSquare(
          imageData.buffer,
          imageData.extension,
        );

        const { buffer, extension } = imageData;
        if (buffer.length > 15 * 1024 * 1024) {
          sendJson(res, 400, {
            success: false,
            error: "Image too large (max 15MB)",
          });
          return;
        }

        fs.mkdirSync(manualImageDir, { recursive: true });
        const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
        const fileName = `${slugify(chapterTitle) || "chapter"}-${uniqueSuffix}${extension}`;
        const filePath = path.join(manualImageDir, fileName);
        fs.writeFileSync(filePath, buffer);
        saveChapterOverride(chapterTitle, filePath);

        sendJson(res, 200, {
          success: true,
          imagePath: filePath,
        });
      } catch (error) {
        sendJson(res, 400, { success: false, error: error.message });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/clear-chapter-image") {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || "{}");
        const chapterTitle = String(payload.chapterTitle || "").trim();
        if (!chapterTitle) {
          sendJson(res, 400, { success: false, error: "Missing chapterTitle" });
          return;
        }

        const cleared = clearChapterOverride(chapterTitle);
        sendJson(res, 200, { success: true, cleared });
      } catch (error) {
        sendJson(res, 400, { success: false, error: error.message });
      }
      return;
    }

    if (req.method === "GET" && pathname === "/api/video-status") {
      const statusFile = parsedUrl.searchParams.get("statusFile");
      if (!statusFile || !path.isAbsolute(statusFile)) {
        sendJson(res, 400, {
          error: "Missing or invalid statusFile parameter",
        });
        return;
      }
      try {
        // "missing" is reported honestly: a run that is about to start writes the
        // file within moments, so the poller can tell that apart from a status file
        // that was deleted (or an episode folder renamed) and stop tracking it,
        // instead of showing "in progress" - and locking the UI - forever.
        sendJson(res, 200, readNormalizedVideoStatus(statusFile));
      } catch {
        sendJson(res, 200, { status: "missing" });
      }
      return;
    }

    // Peak amplitudes for the trim strip: the clip's window plus margin either side,
    // decoded to mono 8 kHz PCM and bucketed. The reported window end reflects what
    // was actually decoded, so a clip near the episode's end gets a truthful axis.
    if (req.method === "POST" && pathname === "/api/clip-waveform") {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || "{}");
        const mp3Path = String(payload.mp3Path || "").trim();
        const startSeconds = Number(payload.startSeconds);
        const endSeconds = Number(payload.endSeconds);
        if (!mp3Path || !path.isAbsolute(mp3Path) || !fs.existsSync(mp3Path)) {
          sendJson(res, 400, {
            success: false,
            error: "Missing or invalid mp3Path",
          });
          return;
        }
        if (
          !Number.isFinite(startSeconds) ||
          !Number.isFinite(endSeconds) ||
          endSeconds <= startSeconds
        ) {
          sendJson(res, 400, {
            success: false,
            error: "Missing or invalid clip time range",
          });
          return;
        }

        const margin = 15;
        const windowStart = Math.max(0, startSeconds - margin);
        const windowDuration = endSeconds + margin - windowStart;

        const decoded = spawnSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-ss",
            String(windowStart),
            "-t",
            String(windowDuration),
            "-i",
            mp3Path,
            "-ac",
            "1",
            "-ar",
            "8000",
            "-f",
            "s16le",
            "pipe:1",
          ],
          { maxBuffer: 64 * 1024 * 1024 },
        );
        if (decoded.status !== 0 || !decoded.stdout) {
          throw new Error(
            `ffmpeg decode failed: ${String(decoded.stderr || "").slice(0, 200)}`,
          );
        }

        const decodedSeconds = Math.floor(decoded.stdout.length / 2) / 8000;
        sendJson(res, 200, {
          success: true,
          windowStart,
          windowEnd: windowStart + decodedSeconds,
          peaks: computeWaveformPeaks(decoded.stdout, 600),
        });
      } catch (error) {
        sendJson(res, 400, { success: false, error: error.message });
      }
      return;
    }

    // The subtitle cues overlapping one clip's window, for the per-card transcript
    // editor. Reads the episode's written (fixed) transcript.vtt when it exists;
    // before a run there is only discovery-time text, which is served read-only since
    // edits are applied to the episode files.
    if (req.method === "POST" && pathname === "/api/clip-cues") {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || "{}");

        const discovered = payload.discoveryData
          ? JSON.parse(payload.discoveryData)
          : null;
        if (!discovered || !discovered.episodeMeta) {
          sendJson(res, 400, {
            success: false,
            error: "Missing or invalid discoveryData",
          });
          return;
        }
        const startSeconds = Number(payload.startSeconds);
        const endSeconds = Number(payload.endSeconds);
        if (
          !Number.isFinite(startSeconds) ||
          !Number.isFinite(endSeconds) ||
          endSeconds <= startSeconds
        ) {
          sendJson(res, 400, {
            success: false,
            error: "Missing or invalid clip time range",
          });
          return;
        }

        const { episodeDir } = deriveEpisodeOutputPaths({
          repoRoot,
          discovered,
          mp3Path: String(payload.mp3Path || ""),
        });
        const vttPath = path.join(episodeDir, "transcript.vtt");
        const editable =
          fs.existsSync(vttPath) &&
          fs.existsSync(path.join(episodeDir, "transcript.md"));
        const vttText = editable
          ? fs.readFileSync(vttPath, "utf8")
          : discovered.transcriptVttText;

        const cues = parseVttCues(vttText || "")
          .filter(
            (cue) =>
              cue.endSeconds > startSeconds && cue.startSeconds < endSeconds,
          )
          .map((cue) => ({
            startSeconds: cue.startSeconds,
            endSeconds: cue.endSeconds,
            speaker: (/^([^:\n]{1,30}):/.exec(cue.text) || [])[1] || null,
            speech: stripSpeakerPrefix(cue.text),
          }));

        sendJson(res, 200, { success: true, editable, cues });
      } catch (error) {
        sendJson(res, 400, { success: false, error: error.message });
      }
      return;
    }

    // Clear & Restart's server half: the run status and the report are what discovery
    // uses to restore completed-run state, suggestions, links and fix memory - without
    // deleting them a "restart" resurrects everything it just cleared. Generated media
    // and episode content files are left alone; a re-approve rewrites those.
    if (req.method === "POST" && pathname === "/api/clear-episode-state") {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || "{}");

        const discovered = payload.discoveryData
          ? JSON.parse(payload.discoveryData)
          : null;
        if (!discovered || !discovered.episodeMeta) {
          sendJson(res, 400, {
            success: false,
            error: "Missing or invalid discoveryData",
          });
          return;
        }

        const { episodeDir, videoStatusFile } = deriveEpisodeOutputPaths({
          repoRoot,
          discovered,
          mp3Path: String(payload.mp3Path || ""),
        });

        if (
          activeVideoStatusFiles.has(videoStatusFile) ||
          activeClipGenerationStatusFiles.has(videoStatusFile)
        ) {
          sendJson(res, 400, {
            success: false,
            error:
              "A render or clip generation is in progress for this episode - wait or cancel first",
          });
          return;
        }

        fs.rmSync(videoStatusFile, { force: true });
        fs.rmSync(path.join(episodeDir, "postprocess-report.json"), {
          force: true,
        });
        sendJson(res, 200, { success: true });
      } catch (error) {
        sendJson(res, 400, { success: false, error: error.message });
      }
      return;
    }

    // Aborts an in-flight clip generation: the signal kills the current ffmpeg child,
    // the truncated output file is removed, and the status file records "cancelled".
    if (req.method === "POST" && pathname === "/api/cancel-clip-generation") {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || "{}");
        const statusFile = String(payload.statusFile || "").trim();
        const controller = clipGenerationAbortControllers.get(statusFile);
        if (!controller) {
          sendJson(res, 400, {
            success: false,
            error: "No clip generation in progress for that status file",
          });
          return;
        }
        controller.abort();
        sendJson(res, 200, { success: true });
      } catch (error) {
        sendJson(res, 400, { success: false, error: error.message });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/generate-clip-videos") {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || "{}");

        const imagePath = String(payload.imagePath || "").trim();
        const mp3Path = String(payload.mp3Path || "").trim();
        const clipSuggestions = Array.isArray(payload.clipSuggestions)
          ? payload.clipSuggestions
          : [];
        const resolvedImagePath =
          imagePath && path.isAbsolute(imagePath) ? imagePath : null;
        const resolvedMp3Path =
          mp3Path && path.isAbsolute(mp3Path) ? mp3Path : null;

        if (!resolvedMp3Path || !fs.existsSync(resolvedMp3Path)) {
          sendJson(res, 400, {
            success: false,
            error: "Missing or invalid mp3Path",
          });
          return;
        }

        const discovered = payload.discoveryData
          ? JSON.parse(payload.discoveryData)
          : null;
        if (!discovered || !Array.isArray(discovered.chapters)) {
          sendJson(res, 400, {
            success: false,
            error: "Missing or invalid discoveryData",
          });
          return;
        }

        // After a page refresh the client no longer holds the run's cover path; the
        // discovery snapshot still carries the cover art extracted at discovery, so
        // clip generation works even without the Assets logo fallback.
        const fallbackCoverPath =
          discovered.fallbackCoverPath &&
          fs.existsSync(discovered.fallbackCoverPath)
            ? discovered.fallbackCoverPath
            : null;

        const clipBaseDirectory = path.dirname(resolvedMp3Path);
        const preferredClipImagePath = resolvePreferredClipImagePath({
          resolvedMp3Path,
          resolvedImagePath: resolvedImagePath || fallbackCoverPath,
        });

        if (!preferredClipImagePath || !fs.existsSync(preferredClipImagePath)) {
          sendJson(res, 400, {
            success: false,
            error: "Missing or invalid imagePath",
          });
          return;
        }

        const clipOutputDir = path.join(clipBaseDirectory, "clip-videos");
        const { episodeDir, videoStatusFile } = deriveEpisodeOutputPaths({
          repoRoot,
          discovered,
          mp3Path: resolvedMp3Path,
        });

        // A second run for the same episode would overwrite the first's abort
        // controller (making it uncancellable), race it over identical output and
        // work-dir file names, and be marked "interrupted" the moment the first run's
        // cleanup removes the status file from the active set.
        if (activeClipGenerationStatusFiles.has(videoStatusFile)) {
          sendJson(res, 409, {
            success: false,
            error:
              "Clip generation is already in progress for this episode - cancel it or wait for it to finish",
          });
          return;
        }

        // Clip subtitles read the episode's written transcript.vtt, which carries any
        // applied AI fixes, falling back to discovery-time text if the run has not
        // written it yet.
        const episodeVttPath = path.join(episodeDir, "transcript.vtt");
        const clipVttText = fs.existsSync(episodeVttPath)
          ? fs.readFileSync(episodeVttPath, "utf8")
          : discovered.transcriptVttText;

        await startQueuedClipGeneration({
          statusFile: videoStatusFile,
          clipSuggestions,
          preferredClipImagePath,
          resolvedMp3Path,
          episodeTitle: discovered.episodeTitle,
          episodeDateString: discovered.dateString,
          transcriptVttText: clipVttText,
        });

        sendJson(res, 200, {
          success: true,
          outputDirectory: clipBaseDirectory,
          imagePathUsed: preferredClipImagePath,
          clipStatusFile: videoStatusFile,
        });
      } catch (error) {
        sendJson(res, 400, { success: false, error: error.message });
      }
      return;
    }

    // Rebuilds clip suggestions from the episode's written (fixed) transcripts when
    // they exist, falling back to discovery-time text before a run. AI picks when a key
    // is configured (cached by content), heuristics otherwise or on failure.
    if (req.method === "POST" && pathname === "/api/clip-suggestions") {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || "{}");

        const discovered = payload.discoveryData
          ? JSON.parse(payload.discoveryData)
          : null;
        if (!discovered || !discovered.episodeMeta) {
          sendJson(res, 400, {
            success: false,
            error: "Missing or invalid discoveryData",
          });
          return;
        }

        const { episodeDir } = deriveEpisodeOutputPaths({
          repoRoot,
          discovered,
          mp3Path: String(payload.mp3Path || ""),
        });
        const mdPath = path.join(episodeDir, "transcript.md");
        const vttPath = path.join(episodeDir, "transcript.vtt");
        const mdText = fs.existsSync(mdPath)
          ? fs.readFileSync(mdPath, "utf8")
          : discovered.transcriptMdText;
        const vttText = fs.existsSync(vttPath)
          ? fs.readFileSync(vttPath, "utf8")
          : discovered.transcriptVttText;

        let clipSuggestions = null;
        let source = "heuristic";
        let warning = null;

        const llm = resolveLlm(loadPostprocessConfig(repoRoot));
        if (llm) {
          try {
            const llmClips = await suggestClipsLlmCached({
              cacheDir: path.join(
                repoRoot,
                ".cache",
                "postprocess",
                "clip-suggestions",
              ),
              transcriptMdText: mdText,
              transcriptVttText: vttText,
              llm,
            });
            if (llmClips.suggestions.length > 0) {
              clipSuggestions = llmClips.suggestions;
              source = "llm";
            } else {
              warning = "AI clip selection returned nothing usable";
            }
          } catch (error) {
            warning = error.message;
          }
        }

        if (!clipSuggestions) {
          clipSuggestions = buildClipSuggestions({
            transcriptMdText: mdText,
            transcriptVttText: vttText,
            maxSuggestions: 8,
          });
        }

        // The report is what discovery reads to restore the cards after a page
        // refresh, so it must always hold the set the user last saw.
        const reportPath = path.join(episodeDir, "postprocess-report.json");
        if (fs.existsSync(reportPath)) {
          const report = readJson(reportPath, {});
          report.clipSuggestions = clipSuggestions;
          report.clipSource = source;
          writeJson(reportPath, report);
        }

        sendJson(res, 200, {
          success: true,
          clipSuggestions,
          source,
          ...(warning ? { warning } : {}),
        });
      } catch (error) {
        sendJson(res, 400, { success: false, error: error.message });
      }
      return;
    }

    // Operates on the episode's written transcripts, after a run has created them.
    // With recheck it reviews the current file contents (cached by content) and applies
    // any high-confidence findings; payload.transcriptFixes (the UI's ticked
    // medium-confidence fixes) are applied either way.
    if (req.method === "POST" && pathname === "/api/transcript-review") {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || "{}");

        const discovered = payload.discoveryData
          ? JSON.parse(payload.discoveryData)
          : null;
        if (!discovered || !discovered.episodeMeta) {
          sendJson(res, 400, {
            success: false,
            error: "Missing or invalid discoveryData",
          });
          return;
        }

        const { episodeDir } = deriveEpisodeOutputPaths({
          repoRoot,
          discovered,
          mp3Path: String(payload.mp3Path || ""),
        });
        const mdPath = path.join(episodeDir, "transcript.md");
        const vttPath = path.join(episodeDir, "transcript.vtt");
        if (!fs.existsSync(mdPath) || !fs.existsSync(vttPath)) {
          sendJson(res, 400, {
            success: false,
            error:
              "Episode transcripts not found - approve and generate files first",
          });
          return;
        }

        const mdText = fs.readFileSync(mdPath, "utf8");
        const vttText = fs.readFileSync(vttPath, "utf8");

        let review = null;
        let fixes = Array.isArray(payload.transcriptFixes)
          ? payload.transcriptFixes
          : [];

        if (payload.recheck) {
          const config = loadPostprocessConfig(repoRoot);
          const llm = resolveLlm(config);
          if (!llm) {
            sendJson(res, 400, {
              success: false,
              error: "No LLM API key configured",
            });
            return;
          }
          review = await reviewTranscriptCached({
            cacheDir: path.join(
              repoRoot,
              ".cache",
              "postprocess",
              "transcript-review",
            ),
            transcriptMdText: mdText,
            transcriptVttText: vttText,
            chapters: discovered.chapters,
            llm,
            hostNames: config.hostNames,
          });
          fixes = [...selectTranscriptFixes(review, undefined), ...fixes];
        }

        const mdResult = applyTranscriptFixes(mdText, fixes);
        const vttResult = applyTranscriptFixes(vttText, fixes);
        if (mdResult.applied.length > 0) {
          fs.writeFileSync(mdPath, mdResult.text, "utf8");
        }
        if (vttResult.applied.length > 0) {
          fs.writeFileSync(vttPath, vttResult.text, "utf8");
        }

        // Applied fixes are remembered in the report so a later re-run - which
        // regenerates the transcripts from source - re-applies them instead of
        // silently dropping corrections the user explicitly approved.
        const reviewReportPath = path.join(
          episodeDir,
          "postprocess-report.json",
        );
        if (mdResult.applied.length > 0 && fs.existsSync(reviewReportPath)) {
          const report = readJson(reviewReportPath, {});
          const remembered = Array.isArray(report.appliedTranscriptFixes)
            ? report.appliedTranscriptFixes
            : [];
          const seen = new Set(remembered.map((fix) => fix.quote));
          for (const fix of mdResult.applied) {
            if (!seen.has(fix.quote)) {
              remembered.push({ quote: fix.quote, correction: fix.correction });
              seen.add(fix.quote);
            }
          }
          report.appliedTranscriptFixes = remembered;
          writeJson(reviewReportPath, report);
        }

        sendJson(res, 200, {
          success: true,
          review,
          fixes: {
            attempted: fixes.length,
            mdApplied: mdResult.applied.length,
            vttApplied: vttResult.applied.length,
            mdMissed: mdResult.missed.map((fix) => fix.quote),
            vttMissed: vttResult.missed.map((fix) => fix.quote),
            appliedQuotes: mdResult.applied.map((fix) => fix.quote),
          },
        });
      } catch (error) {
        sendJson(res, 400, { success: false, error: error.message });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/run") {
      const body = await readRequestBody(req);
      const stream = startNdjsonStream(res);
      try {
        const payload = JSON.parse(body || "{}");

        let runOptions = {
          mp3Path: payload.mp3Path,
          transcriptMdPath: payload.transcriptMdPath,
          transcriptVttPath: payload.transcriptVttPath,
          episodeTitle: payload.episodeTitle,
          description: payload.description,
          publishDate: payload.publishDate,
          skipVideo: Boolean(payload.skipVideo),
          episodeFolderPath: payload.episodeFolderPath,
          shownotesLinks: Array.isArray(payload.shownotesLinks)
            ? payload.shownotesLinks
            : undefined,
          onProgress: stream.progress,
        };

        if (payload.discoveryData) {
          try {
            runOptions.discoveredData = JSON.parse(payload.discoveryData);
          } catch (e) {
            console.error("Failed to parse discoveryData:", e);
          }
        }

        const { report } = await runPipeline(runOptions);
        if (report?.videoStatus?.statusFile) {
          activeVideoStatusFiles.add(report.videoStatus.statusFile);
        }

        stream.result(report);
      } catch (error) {
        stream.error(error.message);
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/rerender-mp4") {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || "{}");

        const mp3Path = String(payload.mp3Path || "").trim();
        if (!mp3Path || !path.isAbsolute(mp3Path) || !fs.existsSync(mp3Path)) {
          sendJson(res, 400, {
            success: false,
            error: "Missing or invalid mp3Path",
          });
          return;
        }

        const discovered = payload.discoveryData
          ? JSON.parse(payload.discoveryData)
          : null;

        if (!discovered || !Array.isArray(discovered.chapters)) {
          sendJson(res, 400, {
            success: false,
            error: "Missing or invalid discoveryData",
          });
          return;
        }

        const { videoStatusFile, videoPath } = deriveEpisodeOutputPaths({
          repoRoot,
          discovered,
          mp3Path,
        });

        const startedAt = new Date().toISOString();
        activeVideoStatusFiles.add(videoStatusFile);

        setImmediate(async () => {
          writeVideoStatusPreserveClipGeneration(videoStatusFile, {
            status: "started",
            startedAt,
            percent: 0,
          });

          try {
            await generateVideoFromChapters({
              chapters: discovered.chapters,
              mp3Path,
              outputPath: videoPath,
              workDir: path.join(
                repoRoot,
                ".cache",
                "postprocess",
                `rerender-${Date.now()}`,
              ),
              onProgress: (progress) => {
                writeVideoStatusPreserveClipGeneration(videoStatusFile, {
                  status: "started",
                  startedAt,
                  ...progress,
                });
              },
            });

            writeVideoStatusPreserveClipGeneration(videoStatusFile, {
              status: "completed",
              completedAt: new Date().toISOString(),
              videoPath,
              percent: 100,
            });
          } catch (error) {
            writeVideoStatusPreserveClipGeneration(videoStatusFile, {
              status: "failed",
              failedAt: new Date().toISOString(),
              error: error.message,
            });
          } finally {
            activeVideoStatusFiles.delete(videoStatusFile);
          }
        });

        sendJson(res, 200, {
          success: true,
          videoStatus: {
            statusFile: videoStatusFile,
          },
        });
      } catch (error) {
        sendJson(res, 400, { success: false, error: error.message });
      }
      return;
    }

    res.statusCode = 404;
    res.end("Not Found");
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      // The Electron app shows a dialog instead of dying to a console nobody sees.
      if (typeof onPortConflict === "function") {
        onPortConflict(error);
        return;
      }
      console.error(
        `Port ${port} is already in use - another postprocess UI is probably running.\n` +
          `Open http://localhost:${port} in your browser, or stop the other instance first.`,
      );
      process.exit(1);
    }
    throw error;
  });

  // Loopback only. This server reads local files and runs the pipeline with no auth,
  // so it must not be reachable from the network.
  server.listen(port, "127.0.0.1", () => {
    console.log(`THS post-process UI running at http://localhost:${port}`);
  });

  return server;
}

module.exports = {
  startServer,
};
