const form = document.getElementById("run-form");
const resultBox = document.getElementById("result");
const previewSection = document.getElementById("image-preview-section");
const chaptersGrid = document.getElementById("chapters-grid");
const approveButton = document.getElementById("approve-button");
const cancelButton = document.getElementById("cancel-button");
const discoverySummarySection = document.getElementById("discovery-summary");
const discoverySummaryContent = document.getElementById(
  "discovery-summary-content",
);

let currentDiscoveryData = null;
let chapterImageOverrides = {}; // Track uploaded replacement images by chapter index
let chapterPasteHandlers = {};
let activePasteChapterIndex = null;
let activePasteBtn = null;
let pasteListenerInstalled = false;

function setInputValue(name, value) {
  const element = form.elements.namedItem(name);
  if (!element) {
    return;
  }

  if (element.type === "checkbox") {
    element.checked = value === "1" || value === "true";
    return;
  }

  element.value = value;
}

function prefillFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const keys = [
    "mp3Path",
    "transcriptMdPath",
    "transcriptVttPath",
    "episodeTitle",
    "description",
    "publishDate",
  ];

  keys.forEach((key) => {
    const value = params.get(key);
    if (value !== null) {
      setInputValue(key, value);
    }
  });

  const dryRun = params.get("dryRun");
  if (dryRun !== null) {
    setInputValue("dryRun", dryRun);
  }

  return params.get("autoRun") === "1";
}

function resolvePossibleImageUrl(rawValue) {
  const trimmed = String(rawValue || "").trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    const fromParam =
      url.searchParams.get("imgurl") ||
      url.searchParams.get("mediaurl") ||
      url.searchParams.get("url");

    if (fromParam && /^https?:\/\//i.test(fromParam)) {
      return fromParam;
    }

    return url.toString();
  } catch {
    return null;
  }
}

function getDropDebugInfo(dataTransfer) {
  if (!dataTransfer) {
    return "types: none";
  }

  const types = Array.from(dataTransfer.types || []);
  const plain = String(dataTransfer.getData("text/plain") || "").slice(0, 120);
  const uri = String(dataTransfer.getData("text/uri-list") || "").slice(0, 120);

  return `types=${types.join(",") || "none"}; plain=${plain || "<empty>"}; uri=${uri || "<empty>"}`;
}

function extractDroppedImageData(dataTransfer) {
  if (!dataTransfer) {
    return {
      imageUrl: null,
      dataUrl: null,
      debug: getDropDebugInfo(dataTransfer),
    };
  }

  const tryValues = [
    dataTransfer.getData("text/uri-list"),
    dataTransfer.getData("text/plain"),
  ];

  for (const value of tryValues) {
    const resolved = resolvePossibleImageUrl(value);
    if (resolved) {
      return {
        imageUrl: resolved,
        dataUrl: null,
        debug: getDropDebugInfo(dataTransfer),
      };
    }
  }

  const html = String(dataTransfer.getData("text/html") || "");
  const srcMatch = /src=["']([^"']+)["']/i.exec(html);
  if (srcMatch && srcMatch[1]) {
    const src = srcMatch[1];
    if (src.startsWith("data:image/")) {
      return {
        imageUrl: null,
        dataUrl: src,
        debug: getDropDebugInfo(dataTransfer),
      };
    }

    const resolved = resolvePossibleImageUrl(src);
    if (resolved) {
      return {
        imageUrl: resolved,
        dataUrl: null,
        debug: getDropDebugInfo(dataTransfer),
      };
    }
  }

  return {
    imageUrl: null,
    dataUrl: null,
    debug: getDropDebugInfo(dataTransfer),
  };
}

function extractImagePayloadFromClipboard(clipboardData) {
  if (!clipboardData) {
    return { imageUrl: null, dataUrl: null };
  }

  const plain = clipboardData.getData("text/plain");
  const resolvedFromPlain = resolvePossibleImageUrl(plain);
  if (resolvedFromPlain) {
    return { imageUrl: resolvedFromPlain, dataUrl: null };
  }

  const html = String(clipboardData.getData("text/html") || "");
  if (html) {
    const srcMatch = /src=["']([^"']+)["']/i.exec(html);
    if (srcMatch && srcMatch[1]) {
      const src = srcMatch[1];
      if (src.startsWith("data:image/")) {
        return { imageUrl: null, dataUrl: src };
      }

      const resolved = resolvePossibleImageUrl(src);
      if (resolved) {
        return { imageUrl: resolved, dataUrl: null };
      }
    }
  }

  return { imageUrl: null, dataUrl: null };
}

function installPasteListener() {
  if (pasteListenerInstalled) {
    return;
  }

  document.addEventListener("paste", async (event) => {
    if (
      activePasteChapterIndex === null ||
      activePasteChapterIndex === undefined
    ) {
      return;
    }

    const handler = chapterPasteHandlers[activePasteChapterIndex];
    if (!handler) {
      return;
    }

    event.preventDefault();
    try {
      const handled = await handler(event.clipboardData);
      if (!handled) {
        showResults(
          "❌ Clipboard did not contain an image. Copy the image itself and paste again.",
        );
      }
    } catch (error) {
      showResults(`❌ Paste failed: ${error.message}`);
    }
  });

  pasteListenerInstalled = true;
}

function renderChapterPreviews(discovered) {
  chaptersGrid.innerHTML = "";
  chapterImageOverrides = {};
  chapterPasteHandlers = {};
  activePasteChapterIndex = null;
  activePasteBtn = null;

  installPasteListener();

  discovered.chapters.forEach((chapter, idx) => {
    const chapterDiv = document.createElement("div");
    chapterDiv.className = "chapter-preview";
    chapterDiv.style.cssText = `
      border: 1px solid #ccc;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 15px;
      background: #f9f9f9;
    `;

    const titleEl = document.createElement("h3");
    titleEl.textContent = `${chapter.timeLabel} - ${chapter.title}`;
    titleEl.style.marginTop = 0;
    chapterDiv.appendChild(titleEl);

    const imageContainer = document.createElement("div");
    imageContainer.style.cssText = `
      display: flex;
      gap: 10px;
      margin-bottom: 10px;
      align-items: flex-start;
    `;

    // Current image
    const imgWrapper = document.createElement("div");
    imgWrapper.style.cssText =
      "position: relative; width: 150px; height: 150px;";

    const currentImg = document.createElement("img");
    currentImg.src = `/api/image?path=${encodeURIComponent(chapter.imagePath)}`;
    currentImg.style.cssText = `
      width: 150px;
      height: 150px;
      border-radius: 4px;
      border: 2px solid #007bff;
      object-fit: cover;
      cursor: pointer;
    `;
    currentImg.id = `image-${idx}-current`;

    const uploadOverlay = document.createElement("div");
    uploadOverlay.style.cssText = `
      display: none;
      position: absolute;
      inset: 0;
      background: rgba(0,0,0,0.45);
      border-radius: 4px;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 0.9em;
      font-weight: bold;
      pointer-events: none;
    `;
    uploadOverlay.textContent = "Uploading\u2026";

    imgWrapper.appendChild(currentImg);
    imgWrapper.appendChild(uploadOverlay);

    const currentLabel = document.createElement("div");
    currentLabel.style.cssText = `
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 5px;
    `;

    currentLabel.appendChild(imgWrapper);

    imageContainer.appendChild(currentLabel);

    const controls = document.createElement("div");
    controls.style.cssText = "display:flex; flex-direction:column; gap:8px;";

    const dropHint = document.createElement("div");
    dropHint.style.cssText = "font-size: 0.9em; color: #666;";
    dropHint.textContent =
      "Drop image on the preview, or click the image to choose";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "Clear replacement";
    clearBtn.style.cssText = `
      padding: 8px 10px;
      cursor: pointer;
      background: #f0f0f0;
      border: 1px solid #ccc;
      border-radius: 4px;
    `;
    clearBtn.disabled = !chapter.imageSource.startsWith("override:");

    const pasteBtn = document.createElement("button");
    pasteBtn.type = "button";
    pasteBtn.textContent = "Paste image (Cmd+V)";
    pasteBtn.style.cssText = `
      padding: 8px 10px;
      cursor: pointer;
      background: #f5f8ff;
      border: 1px solid #99b7ff;
      border-radius: 4px;
    `;

    async function doUpload(uploadPayload) {
      const response = await fetch("/api/upload-chapter-image", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chapterTitle: chapter.title, ...uploadPayload }),
      });

      const body = await response.json();
      if (!response.ok || !body.success) {
        throw new Error(body.error || "Upload failed");
      }

      chapterImageOverrides[idx] = {
        imagePath: body.imagePath,
        imageSource: "manual-upload",
      };
      currentImg.src = `/api/image?path=${encodeURIComponent(body.imagePath)}`;
      activePasteChapterIndex = null;
      pasteBtn.textContent = "Paste image (Cmd+V)";
      pasteBtn.style.background = "#f5f8ff";
      pasteBtn.style.borderColor = "#99b7ff";
      clearBtn.disabled = false;
      showResults(`✓ Uploaded replacement for chapter: ${chapter.title}`);
    }

    async function uploadFile(file) {
      if (!file || !file.type.startsWith("image/")) {
        showResults("❌ Please choose an image file (png/jpg/webp).");
        return;
      }
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Failed to read image file"));
        reader.readAsDataURL(file);
      });
      await doUpload({ originalFileName: file.name, dataUrl });
    }

    async function uploadFromClipboard(clipboardData) {
      const items = Array.from((clipboardData && clipboardData.items) || []);
      for (const item of items) {
        if (item && item.type && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            await uploadFile(file);
            return true;
          }
        }
      }

      const payload = extractImagePayloadFromClipboard(clipboardData);
      if (payload.dataUrl) {
        await doUpload({ dataUrl: payload.dataUrl });
        return true;
      }
      if (payload.imageUrl) {
        await doUpload({ imageUrl: payload.imageUrl });
        return true;
      }

      return false;
    }

    chapterPasteHandlers[idx] = uploadFromClipboard;

    currentImg.addEventListener("click", () => {
      fileInput.click();
    });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        return;
      }
      try {
        await uploadFile(file);
      } catch (error) {
        showResults(`❌ Upload failed: ${error.message}`);
      } finally {
        fileInput.value = "";
      }
    });

    currentImg.addEventListener("dragover", (event) => {
      event.preventDefault();
      currentImg.style.borderColor = "#007bff";
      currentImg.style.boxShadow = "0 0 0 4px rgba(0, 123, 255, 0.2)";
    });

    currentImg.addEventListener("dragleave", () => {
      currentImg.style.borderColor = "#007bff";
      currentImg.style.boxShadow = "none";
    });

    currentImg.addEventListener("drop", async (event) => {
      event.preventDefault();
      currentImg.style.borderColor = "#007bff";
      currentImg.style.boxShadow = "none";

      const file =
        event.dataTransfer &&
        event.dataTransfer.files &&
        event.dataTransfer.files[0];
      const dropped = extractDroppedImageData(event.dataTransfer);

      try {
        if (file) {
          await uploadFile(file);
          return;
        }
        if (dropped.dataUrl) {
          await doUpload({ dataUrl: dropped.dataUrl });
          return;
        }
        if (dropped.imageUrl) {
          await doUpload({ imageUrl: dropped.imageUrl });
          return;
        }
        showResults(
          `❌ Drop payload did not include an image file or usable image URL. Debug: ${dropped.debug}`,
        );
      } catch (error) {
        showResults(
          `❌ Upload failed: ${error.message}. Debug: ${dropped.debug}`,
        );
      }
    });

    clearBtn.addEventListener("click", async () => {
      try {
        const response = await fetch("/api/clear-chapter-image", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            chapterTitle: chapter.title,
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.success === false) {
          throw new Error(body.error || "Failed to clear chapter override");
        }
      } catch (error) {
        showResults(`❌ Failed to clear cached override: ${error.message}`);
        return;
      }

      delete chapterImageOverrides[idx];
      currentImg.src = `/api/image?path=${encodeURIComponent(chapter.imagePath)}`;
      currentImg.style.boxShadow = "none";
      clearBtn.disabled = true;
      showResults(`Cleared replacement for chapter: ${chapter.title}`);
    });

    pasteBtn.addEventListener("click", () => {
      if (activePasteChapterIndex === idx) {
        activePasteChapterIndex = null;
        activePasteBtn = null;
        pasteBtn.textContent = "Paste image (Cmd+V)";
        pasteBtn.style.background = "#f5f8ff";
        pasteBtn.style.borderColor = "#99b7ff";
        showResults("");
        return;
      }
      if (activePasteBtn) {
        activePasteBtn.textContent = "Paste image (Cmd+V)";
        activePasteBtn.style.background = "#f5f8ff";
        activePasteBtn.style.borderColor = "#99b7ff";
      }
      activePasteChapterIndex = idx;
      activePasteBtn = pasteBtn;
      pasteBtn.textContent = "▶ Paste mode active — press Cmd+V";
      pasteBtn.style.background = "#dceeff";
      pasteBtn.style.borderColor = "#007bff";
      showResults(
        `Paste mode active for: ${chapter.title}. Press Cmd+V to paste. Click the button again to cancel.`,
      );
    });

    controls.appendChild(dropHint);
    controls.appendChild(fileInput);
    controls.appendChild(pasteBtn);
    controls.appendChild(clearBtn);
    imageContainer.appendChild(controls);
    chapterDiv.appendChild(imageContainer);
    chaptersGrid.appendChild(chapterDiv);
  });
}

function showResults(text) {
  resultBox.textContent = text;
}

function startStatusSpinner(prefix) {
  const frames = ["|", "/", "-", "\\"];
  let index = 0;
  showResults(`${prefix} ${frames[index]}`);
  const timer = setInterval(() => {
    index = (index + 1) % frames.length;
    showResults(`${prefix} ${frames[index]}`);
  }, 200);

  return () => clearInterval(timer);
}

function renderDiscoverySummary(discovered) {
  const lines = [];
  lines.push(`Episode: ${discovered.episodeTitle}`);
  lines.push(
    `Code: ths-${String(discovered.episodeMeta.seasonCode)}-${String(discovered.episodeMeta.episodeCode)}`,
  );
  lines.push(
    `Season: ${discovered.seasonInfo.seasonName} (Year ${discovered.seasonInfo.year})`,
  );
  lines.push(`Chapters discovered: ${discovered.chapters.length}`);
  lines.push(`Links discovered: ${discovered.links.length}`);
  if (discovered.dateString) {
    lines.push(`Publish date: ${discovered.dateString}`);
  }
  if (discovered.description) {
    lines.push("");
    lines.push(`Description: ${discovered.description}`);
  }

  discoverySummaryContent.textContent = lines.join("\n");
}

function buildDiscoverPayload() {
  const formData = new FormData(form);
  return {
    mp3Path: String(formData.get("mp3Path") || "").trim(),
    transcriptMdPath: String(formData.get("transcriptMdPath") || "").trim(),
    transcriptVttPath: String(formData.get("transcriptVttPath") || "").trim(),
    episodeTitle:
      String(formData.get("episodeTitle") || "").trim() || undefined,
    description: String(formData.get("description") || "").trim() || undefined,
    publishDate: String(formData.get("publishDate") || "").trim() || undefined,
  };
}

let isDiscovering = false;
let pendingDiscovery = false;
let autoDiscoverTimer = null;

async function runDiscovery() {
  const payload = buildDiscoverPayload();

  if (
    !payload.mp3Path ||
    !payload.transcriptMdPath ||
    !payload.transcriptVttPath
  ) {
    form.style.display = "block";
    showResults(
      "Fill in MP3 + transcript paths. Discovery will run automatically.",
    );
    return;
  }

  if (isDiscovering) {
    pendingDiscovery = true;
    return;
  }

  isDiscovering = true;

  const stopDiscoverSpinner = startStatusSpinner("Discovering episode data...");
  form.style.display = "none";
  previewSection.style.display = "none";

  try {
    const response = await fetch("/api/discover", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    stopDiscoverSpinner();

    if (!result.success) {
      showResults(`❌ Discovery failed: ${result.error}`);
      return;
    }

    setInputValue("description", result.discovered.description || "");
    setInputValue("publishDate", result.discovered.dateString || "");
    setInputValue("episodeTitle", result.discovered.episodeTitle || "");

    // Show progress
    const lines = ["=== Discovery Progress ==="];
    if (result.progress && Array.isArray(result.progress)) {
      for (const msg of result.progress) {
        lines.push(`✓ ${msg}`);
      }
    }
    lines.push("");
    lines.push(`Episode: ${result.discovered.episodeTitle}`);
    lines.push(`Chapters: ${result.discovered.chapters.length}`);
    lines.push("");
    lines.push(
      "Review chapter images below and click 'Approve & Generate Files'",
    );

    showResults(lines.join("\n"));

    // Store discovery data and render previews
    currentDiscoveryData = {
      discoveryData: result.discoveryData,
    };

    renderDiscoverySummary(result.discovered);
    discoverySummarySection.style.display = "block";
    renderChapterPreviews(result.discovered);
    previewSection.style.display = "block";
  } catch (error) {
    stopDiscoverSpinner();
    showResults(`Request failed: ${error.message}`);
  } finally {
    form.style.display = "block";
    isDiscovering = false;
    if (pendingDiscovery) {
      pendingDiscovery = false;
      runDiscovery();
    }
  }
}

function scheduleDiscovery() {
  if (autoDiscoverTimer) {
    clearTimeout(autoDiscoverTimer);
  }
  autoDiscoverTimer = setTimeout(() => {
    runDiscovery();
  }, 400);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  runDiscovery();
});

["mp3Path", "transcriptMdPath", "transcriptVttPath", "episodeTitle"].forEach(
  (name) => {
    const input = form.elements.namedItem(name);
    if (input) {
      input.addEventListener("input", scheduleDiscovery);
    }
  },
);

async function pollVideoStatus(statusFile, lines) {
  let videoLineIndex = lines.findIndex((l) => l.includes("MP4 generation"));
  if (videoLineIndex === -1) {
    lines.push("| MP4 generation in progress...");
    videoLineIndex = lines.length - 1;
  }

  const frames = ["|", "/", "-", "\\"];
  let frameIndex = 0;
  const spinner = setInterval(() => {
    lines[videoLineIndex] =
      `${frames[frameIndex % frames.length]} MP4 generation in progress...`;
    frameIndex += 1;
    showResults(lines.join("\n"));
  }, 250);

  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    try {
      const res = await fetch(
        `/api/video-status?statusFile=${encodeURIComponent(statusFile)}`,
      );
      const data = await res.json();

      if (data.status === "completed") {
        clearInterval(spinner);
        lines[videoLineIndex] = `✓ MP4 generation complete`;
        showResults(lines.join("\n"));
        return;
      } else if (data.status === "failed") {
        clearInterval(spinner);
        lines[videoLineIndex] = `❌ MP4 generation failed: ${data.error}`;
        showResults(lines.join("\n"));
        return;
      }
      // still "started" or "pending" — keep polling
    } catch {
      // network error — keep polling
    }
  }

  // Timed out after 10 minutes
  clearInterval(spinner);
  lines[videoLineIndex] =
    `⚠ MP4 generation timed out — check terminal for errors`;
  showResults(lines.join("\n"));
}

approveButton.addEventListener("click", async () => {
  if (!currentDiscoveryData) {
    showResults("❌ No discovery data available");
    return;
  }

  approveButton.disabled = true;
  cancelButton.disabled = true;
  const runFormData = new FormData(form);
  const runPayload = {
    mp3Path: String(runFormData.get("mp3Path") || "").trim(),
    transcriptMdPath: String(runFormData.get("transcriptMdPath") || "").trim(),
    transcriptVttPath: String(
      runFormData.get("transcriptVttPath") || "",
    ).trim(),
    episodeTitle:
      String(runFormData.get("episodeTitle") || "").trim() || undefined,
    description:
      String(runFormData.get("description") || "").trim() || undefined,
    publishDate:
      String(runFormData.get("publishDate") || "").trim() || undefined,
    dryRun: false,
  };

  let stopRunSpinner;
  stopRunSpinner = startStatusSpinner("Generating files and video...");
  previewSection.style.display = "none";

  try {
    let discoveryData = currentDiscoveryData.discoveryData;
    if (discoveryData) {
      const parsed = JSON.parse(discoveryData);

      if (Object.keys(chapterImageOverrides).length > 0) {
        parsed.chapters = parsed.chapters.map((chapter, idx) => {
          const override = chapterImageOverrides[idx];
          if (!override) {
            return chapter;
          }
          return {
            ...chapter,
            imagePath: override.imagePath,
            imageSource: override.imageSource,
          };
        });
      }

      if (runPayload.episodeTitle) {
        parsed.episodeTitle = runPayload.episodeTitle;
      }
      if (runPayload.description) {
        parsed.description = runPayload.description;
      }
      if (runPayload.publishDate) {
        parsed.dateString = runPayload.publishDate;
      }

      discoveryData = JSON.stringify(parsed);
    }

    const response = await fetch("/api/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...runPayload,
        discoveryData,
      }),
    });

    const result = await response.json();
    stopRunSpinner();

    const lines = [];

    if (result.error) {
      lines.push(`❌ Error: ${result.error}`);
    } else if (result.dryRun) {
      lines.push(`Title: ${result.episode.title}`);
      lines.push(`Episode: ${result.episode.guid}`);
      lines.push(`Chapters: ${result.chapterCount}`);
      lines.push("");
      lines.push("Dry run — no files written.");
    } else {
      lines.push(`Title: ${result.episode.title}`);
      lines.push(`Episode: ${result.episode.guid}`);
      lines.push(`Chapters: ${result.chapterCount}`);
      lines.push("");
      if (result.gitBranch) {
        const verb = result.gitBranch.created ? "Created" : "Checked out";
        lines.push(`✓ ${verb} branch: ${result.gitBranch.name}`);
      }
      lines.push(`✓ Episode files written`);
      if (result.mp3ChapterImages && result.mp3ChapterImages.completed) {
        lines.push(
          `✓ MP3 chapter images embedded (${result.mp3ChapterImages.chaptersEmbedded} chapters)`,
        );
      }
      lines.push(`⏳ MP4 generation in progress...`);
    }

    showResults(lines.join("\n"));

    if (
      !result.dryRun &&
      !result.error &&
      result.videoStatus &&
      result.videoStatus.statusFile
    ) {
      pollVideoStatus(result.videoStatus.statusFile, lines);
    }
  } catch (error) {
    if (stopRunSpinner) {
      stopRunSpinner();
    }
    showResults(`Request failed: ${error.message}`);
  } finally {
    approveButton.disabled = false;
    cancelButton.disabled = false;
  }
});

cancelButton.addEventListener("click", () => {
  currentDiscoveryData = null;
  chapterImageOverrides = {};
  previewSection.style.display = "none";
  discoverySummarySection.style.display = "none";
  form.style.display = "block";
  showResults("");
  form.reset();
});

prefillFromQuery();
runDiscovery();
