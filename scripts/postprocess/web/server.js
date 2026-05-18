const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { runPipeline, discoverEpisodeData } = require("../pipeline");
const { normalizeTitle, readJson, writeJson } = require("../utils");

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

function startServer({ port = 4173 } = {}) {
  const publicDir = path.join(__dirname, "public");
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const manualImageDir = path.join(
    repoRoot,
    ".cache",
    "postprocess",
    "manual-images",
  );
  const chapterOverridesPath = path.join(
    repoRoot,
    "data",
    "chapter-image-overrides.json",
  );

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
      if (!imagePath || !path.isAbsolute(imagePath)) {
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
        fs.createReadStream(imagePath).pipe(res);
      } catch {
        res.statusCode = 404;
        res.end("Not Found");
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/discover") {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || "{}");

        const progressMessages = [];
        const onProgress = (message) => {
          progressMessages.push(message);
        };

        const discovered = await discoverEpisodeData({
          mp3Path: payload.mp3Path,
          transcriptMdPath: payload.transcriptMdPath,
          transcriptVttPath: payload.transcriptVttPath,
          episodeTitle: payload.episodeTitle,
          description: payload.description,
          publishDate: payload.publishDate,
          onProgress,
        });

        sendJson(res, 200, {
          success: true,
          progress: progressMessages,
          discovered: {
            episodeTitle: discovered.episodeTitle,
            episodeMeta: discovered.episodeMeta,
            seasonInfo: discovered.seasonInfo,
            description: discovered.description,
            dateString: discovered.dateString,
            chapters: discovered.chapters.map((ch) => ({
              timeLabel: ch.timeLabel,
              title: ch.title,
              durationSeconds: ch.durationSeconds,
              imageSource: ch.imageSource,
              imagePath: ch.imagePath,
            })),
            links: discovered.links,
          },
          // Store serialized data for later generation
          discoveryData: JSON.stringify(discovered),
        });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
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

        const { buffer, extension } = imageData;
        if (buffer.length > 15 * 1024 * 1024) {
          sendJson(res, 400, {
            success: false,
            error: "Image too large (max 15MB)",
          });
          return;
        }

        fs.mkdirSync(manualImageDir, { recursive: true });
        const fileName = `${slugify(chapterTitle) || "chapter"}${extension}`;
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
        const raw = fs.readFileSync(statusFile, "utf8");
        sendJson(res, 200, JSON.parse(raw));
      } catch {
        sendJson(res, 200, { status: "pending" });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/run") {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || "{}");

        const progressMessages = [];
        const onProgress = (message) => {
          progressMessages.push(message);
        };

        // If discovery data is provided, parse it and use it to skip discovery phase
        let runOptions = {
          mp3Path: payload.mp3Path,
          transcriptMdPath: payload.transcriptMdPath,
          transcriptVttPath: payload.transcriptVttPath,
          episodeTitle: payload.episodeTitle,
          description: payload.description,
          publishDate: payload.publishDate,
          dryRun: Boolean(payload.dryRun),
          episodeFolderPath: payload.episodeFolderPath,
          onProgress,
        };

        if (payload.discoveryData) {
          try {
            runOptions.discoveredData = JSON.parse(payload.discoveryData);
          } catch (e) {
            console.error("Failed to parse discoveryData:", e);
          }
        }

        const { report } = await runPipeline(runOptions);

        sendJson(res, 200, {
          ...report,
          progress: progressMessages,
        });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    res.statusCode = 404;
    res.end("Not Found");
  });

  server.listen(port, () => {
    console.log(`THS post-process UI running at http://localhost:${port}`);
  });

  return server;
}

module.exports = {
  startServer,
};
