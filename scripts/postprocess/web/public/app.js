const form = document.getElementById("run-form");
const resultBox = document.getElementById("result");
const previewSection = document.getElementById("image-preview-section");
const chaptersGrid = document.getElementById("chapters-grid");
const approveButton = document.getElementById("approve-button");
const toggleOverridesButton = document.getElementById("toggle-overrides");
const skipVideoCheckbox = document.getElementById("skip-video");
const discoverySummarySection = document.getElementById("discovery-summary");
const discoverySummaryContent = document.getElementById(
  "discovery-summary-content",
);

let currentDiscoveryData = null;
let chapterImageOverrides = {}; // Track uploaded replacement images by chapter index
const statusLines = [];

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

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read clipboard image"));
    reader.readAsDataURL(blob);
  });
}

async function uploadFromSystemClipboard(uploadHandler) {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    throw new Error(
      "Automatic clipboard image pasting is not supported in this browser",
    );
  }

  const items = await navigator.clipboard.read();
  for (const item of items) {
    for (const type of item.types || []) {
      if (!type.startsWith("image/")) {
        continue;
      }
      const blob = await item.getType(type);
      const dataUrl = await blobToDataUrl(blob);
      if (dataUrl) {
        await uploadHandler({ dataUrl });
        return true;
      }
    }
  }

  return false;
}

function renderChapterPreviews(discovered) {
  chaptersGrid.innerHTML = "";
  chapterImageOverrides = {};

  discovered.chapters.forEach((chapter, idx) => {
    const chapterDiv = document.createElement("div");
    chapterDiv.className = "chapter-preview";
    chapterDiv.style.cssText = `
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 15px;
      background: linear-gradient(180deg, var(--panel), var(--panel-alt));
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.03) inset;
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
      border: 2px solid var(--accent-strong);
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
    dropHint.style.cssText = "font-size: 0.9em; color: var(--muted);";
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
      background: var(--panel-alt);
      border: 1px solid var(--line);
      border-radius: 4px;
    `;
    clearBtn.disabled = !chapter.imageSource.startsWith("override:");

    const pasteBtn = document.createElement("button");
    pasteBtn.type = "button";
    pasteBtn.textContent = "Paste image";
    pasteBtn.style.cssText = `
      padding: 8px 10px;
      cursor: pointer;
      background: #17233a;
      border: 1px solid var(--accent);
      border-radius: 4px;
    `;

    const clearTargetImagePath = chapter.defaultImagePath || chapter.imagePath;

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
      clearBtn.disabled = false;
      addStatus(`✓ Uploaded replacement for chapter: ${chapter.title}`);
    }

    async function uploadFile(file) {
      if (!file || !file.type.startsWith("image/")) {
        addStatus("❌ Please choose an image file (png/jpg/webp).");
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
        addStatus(`❌ Upload failed: ${error.message}`);
      } finally {
        fileInput.value = "";
      }
    });

    currentImg.addEventListener("dragover", (event) => {
      event.preventDefault();
      currentImg.style.borderColor = "var(--accent)";
      currentImg.style.boxShadow = "0 0 0 4px rgba(56, 189, 248, 0.15)";
    });

    currentImg.addEventListener("dragleave", () => {
      currentImg.style.borderColor = "var(--accent-strong)";
      currentImg.style.boxShadow = "none";
    });

    currentImg.addEventListener("drop", async (event) => {
      event.preventDefault();
      currentImg.style.borderColor = "var(--accent-strong)";
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
        addStatus(
          `❌ Drop payload did not include an image file or usable image URL. Debug: ${dropped.debug}`,
        );
      } catch (error) {
        addStatus(
          `❌ Upload failed: ${error.message}. Debug: ${dropped.debug}`,
        );
      }
    });

    clearBtn.addEventListener("click", async () => {
      const previousOverride = chapterImageOverrides[idx];
      delete chapterImageOverrides[idx];
      currentImg.src = `/api/image?path=${encodeURIComponent(clearTargetImagePath)}`;
      currentImg.style.boxShadow = "none";
      clearBtn.disabled = true;

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
        if (previousOverride) {
          chapterImageOverrides[idx] = previousOverride;
          currentImg.src = `/api/image?path=${encodeURIComponent(previousOverride.imagePath)}`;
          clearBtn.disabled = false;
        }
        addStatus(`❌ Failed to clear cached override: ${error.message}`);
        return;
      }

      addStatus(`✓ Cleared replacement for chapter: ${chapter.title}`);
    });

    pasteBtn.addEventListener("click", () => {
      (async () => {
        try {
          const handled = await uploadFromSystemClipboard(doUpload);
          if (!handled) {
            addStatus(
              `❌ Clipboard does not contain an image for: ${chapter.title}`,
            );
          } else {
            addStatus(`✓ Pasted clipboard image for: ${chapter.title}`);
          }
        } catch (error) {
          addStatus(`❌ Clipboard paste failed: ${error.message}`);
        }
      })();
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

function renderStatus() {
  resultBox.textContent = statusLines.join("\n");
}

function addStatus(text) {
  if (!text) {
    return -1;
  }
  statusLines.push(String(text));
  renderStatus();
  return statusLines.length - 1;
}

function setStatusLine(index, text) {
  if (index < 0 || index >= statusLines.length) {
    return;
  }
  statusLines[index] = String(text);
  renderStatus();
}

function startStatusSpinner(prefix, suffix = "") {
  const frames = ["|", "/", "-", "\\"];
  let frame = 0;
  const lineIndex = addStatus(`${prefix} ${frames[0]}${suffix}`);
  const timer = setInterval(() => {
    frame = (frame + 1) % frames.length;
    setStatusLine(lineIndex, `${prefix} ${frames[frame]}${suffix}`);
  }, 200);

  return (finalText) => {
    clearInterval(timer);
    if (finalText) {
      setStatusLine(lineIndex, finalText);
    }
    return lineIndex;
  };
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
  lines.push(`Links placeholders: ${discovered.hiddenLinkTitles.length}`);
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
    toggleOverridesButton.style.display = "none";
    addStatus(
      "Fill in MP3 + transcript paths. Discovery will run automatically.",
    );
    return;
  }

  if (isDiscovering) {
    pendingDiscovery = true;
    return;
  }

  isDiscovering = true;
  toggleOverridesButton.style.display = "none";

  const stopDiscoverSpinner = startStatusSpinner("Discovering episode data...");
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

    stopDiscoverSpinner("✓ Discovery complete");

    if (!result.success) {
      toggleOverridesButton.style.display = "none";
      addStatus(`❌ Discovery failed: ${result.error}`);
      return;
    }

    setInputValue("description", result.discovered.description || "");
    setInputValue("publishDate", result.discovered.dateString || "");
    setInputValue("episodeTitle", result.discovered.episodeTitle || "");

    if (result.progress && Array.isArray(result.progress)) {
      for (const msg of result.progress) {
        addStatus(`• ${msg}`);
      }
    }
    addStatus("✓ Chapter images ready for review");

    // Store discovery data and render previews
    currentDiscoveryData = {
      discoveryData: result.discoveryData,
    };

    toggleOverridesButton.style.display = "inline-block";

    renderDiscoverySummary(result.discovered);
    discoverySummarySection.style.display = "block";
    renderChapterPreviews(result.discovered);
    previewSection.style.display = "block";
  } catch (error) {
    stopDiscoverSpinner();
    addStatus(`❌ Request failed: ${error.message}`);
  } finally {
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
  let videoLineIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (String(lines[i]).includes("MP4 generation")) {
      videoLineIndex = i;
      break;
    }
  }
  if (videoLineIndex === -1) {
    lines.push("| MP4 generation in progress... (0%)");
    videoLineIndex = lines.length - 1;
  }

  const frames = ["|", "/", "-", "\\"];
  let frameIndex = 0;
  const spinner = setInterval(() => {
    lines[videoLineIndex] =
      `${frames[frameIndex % frames.length]} MP4 generation in progress...`;
    frameIndex += 1;
    setStatusLine(videoLineIndex, lines[videoLineIndex]);
  }, 250);

  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    try {
      const res = await fetch(
        `/api/video-status?statusFile=${encodeURIComponent(statusFile)}`,
      );
      const data = await res.json();
      const percentSuffix =
        typeof data.percent === "number" ? ` (${data.percent}%)` : "";

      if (data.status === "completed") {
        clearInterval(spinner);
        lines[videoLineIndex] = `✓ MP4 generation complete`;
        setStatusLine(videoLineIndex, lines[videoLineIndex]);
        return;
      } else if (data.status === "failed") {
        clearInterval(spinner);
        lines[videoLineIndex] = `❌ MP4 generation failed: ${data.error}`;
        setStatusLine(videoLineIndex, lines[videoLineIndex]);
        return;
      } else {
        lines[videoLineIndex] =
          `${frames[frameIndex % frames.length]} MP4 generation in progress...${percentSuffix}`;
        setStatusLine(videoLineIndex, lines[videoLineIndex]);
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
  setStatusLine(videoLineIndex, lines[videoLineIndex]);
}

approveButton.addEventListener("click", async () => {
  if (!currentDiscoveryData) {
    addStatus("❌ No discovery data available");
    return;
  }

  approveButton.disabled = true;
  toggleOverridesButton.style.display = "none";
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
    skipVideo: Boolean(skipVideoCheckbox && skipVideoCheckbox.checked),
  };

  let stopRunSpinner;
  stopRunSpinner = startStatusSpinner("Generating files and outputs...");
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
    stopRunSpinner("✓ Generation completed");

    if (result.error) {
      addStatus(`❌ Error: ${result.error}`);
    } else {
      if (result.gitBranch) {
        const verb = result.gitBranch.created ? "Created" : "Checked out";
        addStatus(`✓ ${verb} branch: ${result.gitBranch.name}`);
      }
      addStatus("✓ Episode files written");
      if (result.mp3ChapterImages && result.mp3ChapterImages.completed) {
        addStatus(
          `✓ MP3 chapter images embedded (${result.mp3ChapterImages.chaptersEmbedded} chapters)`,
        );
      }
      if (result.videoStatus && result.videoStatus.skipped) {
        addStatus("✓ MP4 generation skipped");
      } else if (result.videoStatus && result.videoStatus.statusFile) {
        addStatus("⏳ MP4 generation in progress... (0%)");
        pollVideoStatus(result.videoStatus.statusFile, statusLines);
      }
    }
  } catch (error) {
    if (stopRunSpinner) {
      stopRunSpinner();
    }
    addStatus(`❌ Request failed: ${error.message}`);
  } finally {
    approveButton.disabled = false;
  }
});

toggleOverridesButton.addEventListener("click", () => {
  const showing = form.style.display !== "none";
  form.style.display = showing ? "none" : "block";
  toggleOverridesButton.textContent = showing
    ? "Show Overrides"
    : "Hide Overrides";
});

prefillFromQuery();
runDiscovery();
