const form = document.getElementById("run-form");
const resultBox = document.getElementById("result");
const processActionsSection = document.getElementById(
  "process-actions-section",
);
const restartProcessButton = document.getElementById("restart-process-button");
const rerenderMp4Button = document.getElementById("rerender-mp4-button");
const regenerateClipsButton = document.getElementById(
  "regenerate-clips-button",
);
const previewSection = document.getElementById("image-preview-section");
const chaptersGrid = document.getElementById("chapters-grid");
const approveButton = document.getElementById("approve-button");
const toggleOverridesButton = document.getElementById("toggle-overrides");
const skipVideoCheckbox = document.getElementById("skip-video");
const discoverySummarySection = document.getElementById("discovery-summary");
const discoverySummaryContent = document.getElementById(
  "discovery-summary-content",
);
const clipSuggestionsSection = document.getElementById(
  "clip-suggestions-section",
);
const clipSuggestionsList = document.getElementById("clip-suggestions-list");
const clipQueueNote = document.getElementById("clip-queue-note");
const clipSuggestionsSummary = document.getElementById(
  "clip-suggestions-summary",
);
const transcriptReviewSection = document.getElementById(
  "transcript-review-section",
);
const transcriptReviewList = document.getElementById("transcript-review-list");
const applyTranscriptFixesButton = document.getElementById(
  "apply-transcript-fixes-button",
);
const shownotesLinksSection = document.getElementById(
  "shownotes-links-section",
);
const shownotesLinksList = document.getElementById("shownotes-links-list");
const addShownotesLinkButton = document.getElementById(
  "add-shownotes-link-button",
);
const recheckTranscriptButton = document.getElementById(
  "recheck-transcript-button",
);
const cancelClipsButton = document.getElementById("cancel-clips-button");
const generateClipVideosButton = document.getElementById(
  "generate-clip-videos-button",
);

let currentDiscoveryData = null;
let currentRunResult = null;
let currentClipSuggestions = [];
let clipApprovalState = [];
let activeVideoStatusFile = null;
let activeVideoStatusPoll = null;
let activeClipStatusFile = null;
let activeClipStatusPoll = null;
let isGeneratingClips = false;
let isVideoRenderInProgress = false;
// True only while the /api/run request itself is outstanding: the run rewrites the MP3
// (chapter-image embed) that clip generation reads, so queueing must wait for the
// response even though the clip section stays visible.
let isRunRequestInFlight = false;
let isVideoRenderCompleted = false;
let chapterImageOverrides = {}; // Track uploaded replacement images by chapter index
let currentTranscriptFindings = [];
let shownotesLinks = [];
let draggedLinkIndex = null;
// Keyed by quote rather than index so ticks survive the fresh discovery the approve
// flow runs (cached findings come back identical, but order is not guaranteed).
let mediumFixAccepted = {};
const statusLines = [];
let statusLineSeq = 0;
const VIDEO_STATUS_STORAGE_KEY = "ths-postprocess-active-video-status-file";
const CLIP_STATUS_STORAGE_KEY = "ths-postprocess-active-clip-status-file";

function setVideoRenderUiState(inProgress) {
  isVideoRenderInProgress = Boolean(inProgress);

  if (isVideoRenderInProgress) {
    isVideoRenderCompleted = false;
  }

  if (isVideoRenderInProgress) {
    toggleOverridesButton.style.display = "none";
    previewSection.style.display = "none";
    shownotesLinksSection.style.display = "none";
    approveButton.disabled = true;
    rerenderMp4Button.disabled = true;
    restartProcessButton.disabled = true;
  } else {
    approveButton.disabled = false;
    rerenderMp4Button.disabled = false;
    restartProcessButton.disabled = false;
  }

  // The clip section stays usable either way; re-render so the queue note and the
  // generate button reflect the new state.
  renderClipSuggestions(currentClipSuggestions);
}

function setVideoRenderCompletedUiState(completed) {
  isVideoRenderCompleted = Boolean(completed);
  if (!isVideoRenderCompleted) {
    return;
  }

  isVideoRenderInProgress = false;
  toggleOverridesButton.style.display = "none";
  previewSection.style.display = "none";
  shownotesLinksSection.style.display = "none";
  clipSuggestionsSection.style.display = "none";
  approveButton.disabled = true;
  generateClipVideosButton.style.display = "none";
  rerenderMp4Button.disabled = false;
  restartProcessButton.disabled = false;
  regenerateClipsButton.disabled = false;
}

function setProcessActionsVisibility() {
  processActionsSection.style.display = currentDiscoveryData ? "block" : "none";
}

function getDiscoverySnapshot() {
  if (!currentDiscoveryData?.discoveryData) {
    return null;
  }

  try {
    return JSON.parse(currentDiscoveryData.discoveryData);
  } catch {
    return null;
  }
}

function persistActiveVideoStatusFile(statusFile) {
  try {
    if (!statusFile) {
      localStorage.removeItem(VIDEO_STATUS_STORAGE_KEY);
      return;
    }
    localStorage.setItem(VIDEO_STATUS_STORAGE_KEY, String(statusFile));
  } catch {
    // localStorage may be unavailable; ignore persistence failures.
  }
}

function persistActiveClipStatusFile(statusFile) {
  try {
    if (!statusFile) {
      localStorage.removeItem(CLIP_STATUS_STORAGE_KEY);
      return;
    }
    localStorage.setItem(CLIP_STATUS_STORAGE_KEY, String(statusFile));
  } catch {
    // Ignore persistence failures.
  }
}

function readPersistedVideoStatusFile() {
  try {
    return String(localStorage.getItem(VIDEO_STATUS_STORAGE_KEY) || "").trim();
  } catch {
    return "";
  }
}

function readPersistedClipStatusFile() {
  try {
    return String(localStorage.getItem(CLIP_STATUS_STORAGE_KEY) || "").trim();
  } catch {
    return "";
  }
}

function imageApiUrl(imagePath) {
  return `/api/image?path=${encodeURIComponent(imagePath)}&v=${Date.now()}`;
}

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

function extractPastedImageFile(clipboardData) {
  if (!clipboardData) {
    return null;
  }

  const items = Array.from(clipboardData.items || []);
  for (const item of items) {
    if (item.kind === "file" && item.type && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        return file;
      }
    }
  }

  const files = Array.from(clipboardData.files || []);
  for (const file of files) {
    if (file && file.type && file.type.startsWith("image/")) {
      return file;
    }
  }

  return null;
}

function waitForNextPastedImageDataUrl({ timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;

    const cleanup = () => {
      window.removeEventListener("paste", onPaste, true);
      clearTimeout(timer);
    };

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };

    const onPaste = (event) => {
      const file = extractPastedImageFile(event.clipboardData);
      if (!file) {
        return;
      }

      event.preventDefault();

      const reader = new FileReader();
      reader.onload = () => finish(String(reader.result || ""));
      reader.onerror = () => finish(null);
      reader.readAsDataURL(file);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    window.addEventListener("paste", onPaste, true);
  });
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

    const imgWrapper = document.createElement("div");
    imgWrapper.style.cssText =
      "position: relative; width: 150px; height: 150px;";

    const currentImg = document.createElement("img");
    currentImg.src = imageApiUrl(chapter.imagePath);
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
      currentImg.src = imageApiUrl(body.imagePath);
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
      currentImg.src = imageApiUrl(clearTargetImagePath);
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
          currentImg.src = imageApiUrl(previousOverride.imagePath);
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
          const handled = await uploadFromSystemClipboard(doUpload).catch(
            () => false,
          );
          if (handled) {
            addStatus(`✓ Pasted clipboard image for: ${chapter.title}`);
            return;
          }

          addStatus(`Paste now (Cmd+V) for chapter: ${chapter.title}`);
          const dataUrl = await waitForNextPastedImageDataUrl();
          if (!dataUrl) {
            addStatus(`❌ No pasted image received for: ${chapter.title}`);
            return;
          }
          await doUpload({ dataUrl });
          addStatus(`✓ Pasted clipboard image for: ${chapter.title}`);
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
  resultBox.textContent = statusLines.map((line) => line.text).join("\n");
}

function resetStatus() {
  statusLines.length = 0;
  setStatusAlertState(false);
  renderStatus();
}

function addStatus(text) {
  if (!text) {
    return null;
  }
  statusLineSeq += 1;
  const id = statusLineSeq;
  statusLines.push({ id, text: String(text) });
  renderStatus();
  return id;
}

// Lines are addressed by id, not position: a long-running poller holds its handle across
// a resetStatus() (which auto-discovery triggers on any input change) and its line is
// re-added rather than lost or written over somebody else's.
function setStatusLine(id, text) {
  if (id === null || id === undefined) {
    return;
  }

  const existing = statusLines.find((line) => line.id === id);
  if (existing) {
    existing.text = String(text);
  } else {
    statusLines.push({ id, text: String(text) });
  }
  renderStatus();
}

function findStatusLineId(substring) {
  for (let index = statusLines.length - 1; index >= 0; index -= 1) {
    if (statusLines[index].text.includes(substring)) {
      return statusLines[index].id;
    }
  }
  return null;
}

function startStatusSpinner(prefix, suffix = "") {
  const frames = ["|", "/", "-", "\\"];
  let frame = 0;
  const lineId = addStatus(`${prefix} ${frames[0]}${suffix}`);
  const timer = setInterval(() => {
    frame = (frame + 1) % frames.length;
    setStatusLine(lineId, `${prefix} ${frames[frame]}${suffix}`);
  }, 200);

  return (finalText) => {
    clearInterval(timer);
    if (finalText) {
      setStatusLine(lineId, finalText);
    }
    return lineId;
  };
}

function setStatusAlertState(enabled) {
  if (enabled) {
    resultBox.style.borderColor = "#b91c1c";
    resultBox.style.boxShadow =
      "0 0 0 1px rgba(185, 28, 28, 0.35), 0 0 20px rgba(185, 28, 28, 0.18)";
    return;
  }

  resultBox.style.borderColor = "";
  resultBox.style.boxShadow = "";
}

// The AI check runs during generation: the run applies high-confidence fixes to the
// written episode transcripts itself, so only medium-confidence suggestions are kept
// here, for the user to tick and apply. Sources are never modified.
function renderTranscriptReview(review) {
  if (!review || !review.enabled) {
    return;
  }

  if (review.error) {
    addStatus(
      `⚠ AI transcript check failed: ${review.error} — use "Re-run Transcript Check" to try again`,
    );
    return;
  }

  const findings = Array.isArray(review.findings) ? review.findings : [];
  currentTranscriptFindings = findings.filter(
    (finding) => finding.confidence !== "high",
  );

  if (findings.length === 0) {
    addStatus("✓ AI transcript check: no likely mistranscriptions found");
  } else if (currentTranscriptFindings.length > 0) {
    addStatus(
      `⚠ AI transcript check: ${currentTranscriptFindings.length} medium-confidence suggestion(s) need review below`,
    );
  }
  renderTranscriptFixSection();
}

function renderTranscriptFixSection() {
  transcriptReviewList.innerHTML = "";

  if (currentTranscriptFindings.length === 0) {
    transcriptReviewSection.style.display = "none";
    return;
  }

  transcriptReviewSection.style.display = "block";

  currentTranscriptFindings.forEach((finding) => {
    const row = document.createElement("div");
    row.style.cssText = `
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 8px;
      background: var(--panel-alt);
    `;

    const change = document.createElement("div");
    change.style.marginBottom = "4px";
    const before = document.createElement("del");
    before.textContent = `"${finding.quote}"`;
    before.style.color = "var(--muted)";
    const after = document.createElement("strong");
    after.textContent = `"${finding.correction}"`;
    change.appendChild(before);
    change.appendChild(document.createTextNode(" → "));
    change.appendChild(after);
    row.appendChild(change);

    const meta = document.createElement("div");
    meta.style.cssText = "font-size: 0.85em; color: var(--muted);";
    meta.textContent = finding.reason || "";
    row.appendChild(meta);

    const label = document.createElement("label");
    label.style.cssText =
      "display: flex; gap: 6px; align-items: center; margin-top: 6px; font-size: 0.9em; cursor: pointer;";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(mediumFixAccepted[finding.quote]);
    checkbox.addEventListener("change", () => {
      mediumFixAccepted[finding.quote] = checkbox.checked;
    });
    label.appendChild(checkbox);
    label.appendChild(
      document.createTextNode("Apply this fix (medium confidence)"),
    );
    row.appendChild(label);

    transcriptReviewList.appendChild(row);
  });
}

function getTickedTranscriptFixes() {
  return currentTranscriptFindings
    .filter((finding) => mediumFixAccepted[finding.quote])
    .map((finding) => ({
      quote: finding.quote,
      correction: finding.correction,
    }));
}

function renderTranscriptFixResult(fixes) {
  if (!fixes || !fixes.attempted) {
    return;
  }
  addStatus(
    `✓ Transcript fixes applied: ${fixes.mdApplied} in transcript.md, ${fixes.vttApplied} in transcript.vtt`,
  );
  for (const quote of fixes.mdMissed || []) {
    addStatus(`  ⚠ Not found in transcript.md (fix by hand): "${quote}"`);
  }
  for (const quote of fixes.vttMissed || []) {
    addStatus(`  ⚠ Not found in transcript.vtt (fix by hand): "${quote}"`);
  }
}

// Editable rows for the generated index.md's Links section: seeded from the
// auto-resolved Steam links (or the last run's edited list), with rows freely added,
// edited and removed. State lives in shownotesLinks; text edits mutate it directly so
// typing never triggers a re-render (which would steal focus).
function renderShownotesLinks() {
  shownotesLinksList.innerHTML = "";

  shownotesLinks.forEach((link, index) => {
    const row = document.createElement("div");
    row.style.cssText =
      "display: flex; gap: 8px; margin-bottom: 8px; align-items: center;";

    // Dragging is armed only from the handle: a draggable row would hijack text
    // selection inside the inputs.
    const handle = document.createElement("span");
    handle.textContent = "⠿";
    handle.title = "Drag to reorder";
    handle.style.cssText =
      "cursor: grab; color: var(--muted); user-select: none; padding: 0 2px;";
    handle.addEventListener("mousedown", () => {
      row.draggable = true;
    });
    handle.addEventListener("mouseup", () => {
      row.draggable = false;
    });

    row.addEventListener("dragstart", (event) => {
      draggedLinkIndex = index;
      event.dataTransfer.effectAllowed = "move";
      row.style.opacity = "0.4";
    });
    // The indicator and the drop must share one decision, or the line lies about
    // where the row will land: above the target when the pointer is in its top half,
    // below it otherwise. Drawn with a box-shadow so rows don't shift while dragging.
    const dropsBelow = (event) => {
      const rect = row.getBoundingClientRect();
      return event.clientY >= rect.top + rect.height / 2;
    };

    row.addEventListener("dragend", () => {
      row.draggable = false;
      row.style.opacity = "";
      draggedLinkIndex = null;
      for (const sibling of shownotesLinksList.children) {
        sibling.style.boxShadow = "";
      }
    });
    row.addEventListener("dragover", (event) => {
      if (draggedLinkIndex === null || draggedLinkIndex === index) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      for (const sibling of shownotesLinksList.children) {
        sibling.style.boxShadow = "";
      }
      row.style.boxShadow = dropsBelow(event)
        ? "0 2px 0 var(--accent)"
        : "0 -2px 0 var(--accent)";
    });
    row.addEventListener("dragleave", () => {
      row.style.boxShadow = "";
    });
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      if (draggedLinkIndex === null || draggedLinkIndex === index) {
        return;
      }
      let target = index + (dropsBelow(event) ? 1 : 0);
      if (draggedLinkIndex < target) {
        target -= 1;
      }
      const [moved] = shownotesLinks.splice(draggedLinkIndex, 1);
      shownotesLinks.splice(target, 0, moved);
      draggedLinkIndex = null;
      renderShownotesLinks();
    });

    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.placeholder = "Title";
    titleInput.value = link.title || "";
    titleInput.style.flex = "1";
    titleInput.addEventListener("input", () => {
      link.title = titleInput.value;
    });

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.placeholder = "https://...";
    urlInput.value = link.url || "";
    urlInput.style.flex = "2";
    urlInput.addEventListener("input", () => {
      link.url = urlInput.value;
    });
    // A pasted URL gets its page title fetched as an editable default, but never
    // overwrites a title the user has typed in the meantime.
    urlInput.addEventListener("blur", async () => {
      const url = urlInput.value.trim();
      if (!url || titleInput.value.trim()) {
        return;
      }
      titleInput.placeholder = "Fetching title...";
      try {
        const response = await fetch("/api/fetch-link-title", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ url }),
        });
        const body = await response.json();
        if (
          response.ok &&
          body.success &&
          body.title &&
          !titleInput.value.trim()
        ) {
          titleInput.value = body.title;
          link.title = body.title;
        }
      } catch {
        // No title is fine; the user types one.
      } finally {
        titleInput.placeholder = "Title";
      }
    });

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.textContent = "✕";
    removeButton.addEventListener("click", () => {
      shownotesLinks.splice(index, 1);
      renderShownotesLinks();
    });

    row.appendChild(handle);
    row.appendChild(titleInput);
    row.appendChild(urlInput);
    row.appendChild(removeButton);
    shownotesLinksList.appendChild(row);
  });
}

addShownotesLinkButton.addEventListener("click", () => {
  shownotesLinks.push({ title: "", url: "" });
  renderShownotesLinks();
  shownotesLinksList.lastElementChild?.querySelector("input")?.focus();
});

function renderProfanityStatus(
  transcriptChecks,
  phaseLabel = "Check",
  transcriptPath = "",
) {
  const mdMatches = Array.isArray(transcriptChecks?.transcriptMd)
    ? transcriptChecks.transcriptMd
    : [];
  const totalMatches = mdMatches.length;
  const pathLabel = transcriptPath ? ` (${transcriptPath})` : "";

  if (totalMatches <= 0) {
    addStatus(`[${phaseLabel}] No profanity matches found${pathLabel}.`);
    setStatusAlertState(false);
    return;
  }

  setStatusAlertState(true);
  addStatus(
    `!!! PROFANITY DETECTED (${totalMatches} match(es))${pathLabel} !!!`,
  );
  addStatus(`[${phaseLabel}] transcript.md: ${mdMatches.length}`);

  const countsByWord = mdMatches.reduce((acc, match) => {
    const key = String(match.word || "unknown");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(countsByWord)
    .sort((a, b) => b[1] - a[1])
    .map(([word, count]) => `${word} (${count})`)
    .join(", ");
  if (summary) {
    addStatus(`[${phaseLabel}] detected words: ${summary}`);
  }

  const examples = mdMatches
    .slice(0, 8)
    .map((match) => ({ source: "transcript.md", ...match }));

  for (const match of examples) {
    addStatus(
      `  - ${match.word} at ${match.source}:${match.line} -> ${String(match.text || "").slice(0, 110)}`,
    );
  }
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

// One shared player: starting a preview stops any other, and playback pauses itself
// once it passes the clip's end time. The source MP3 is range-served, so seeking to a
// clip deep into the episode is immediate.
let clipPreviewAudio = null;
let clipPreviewSrcPath = null;
let clipPreviewStopAt = Infinity;
let clipPreviewButton = null;

function stopClipPreview() {
  if (clipPreviewAudio) {
    clipPreviewAudio.pause();
  }
  if (clipPreviewButton) {
    clipPreviewButton.textContent = "▶ Preview";
    clipPreviewButton = null;
  }
}

function playClipPreview(suggestion, button) {
  if (clipPreviewButton === button) {
    stopClipPreview();
    return;
  }

  const mp3Path = buildDiscoverPayload().mp3Path;
  if (!mp3Path) {
    addStatus("❌ No MP3 path set; cannot preview audio.");
    return;
  }

  stopClipPreview();

  if (!clipPreviewAudio) {
    clipPreviewAudio = new Audio();
    clipPreviewAudio.addEventListener("timeupdate", () => {
      if (clipPreviewAudio.currentTime >= clipPreviewStopAt) {
        stopClipPreview();
      }
    });
    clipPreviewAudio.addEventListener("ended", stopClipPreview);
  }

  const startSeconds = Math.max(0, Number(suggestion.startSeconds) || 0);
  clipPreviewStopAt = Number(suggestion.endSeconds)
    ? Number(suggestion.endSeconds)
    : startSeconds + (Number(suggestion.durationSeconds) || 60);

  const src = `/api/audio?path=${encodeURIComponent(mp3Path)}`;
  const seekAndPlay = () => {
    clipPreviewAudio.currentTime = startSeconds;
    clipPreviewAudio
      .play()
      .catch((error) => addStatus(`❌ Audio preview failed: ${error.message}`));
  };

  if (clipPreviewSrcPath === mp3Path && clipPreviewAudio.readyState >= 1) {
    seekAndPlay();
  } else {
    clipPreviewSrcPath = mp3Path;
    clipPreviewAudio.src = src;
    clipPreviewAudio.addEventListener("loadedmetadata", seekAndPlay, {
      once: true,
    });
  }

  button.textContent = "■ Stop";
  clipPreviewButton = button;
}

function formatCueTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// The per-card transcript editor: the clip's cues load on first open, edit in place,
// and save as quote->correction fixes through the same endpoint as the AI transcript
// fixes - so edits land in both episode transcripts, are remembered across re-runs,
// and reach the burned-in subtitles on the next clip render.
function buildClipTranscriptEditor(suggestion) {
  const details = document.createElement("details");
  details.style.marginBottom = "10px";
  const toggle = document.createElement("summary");
  toggle.textContent = "Transcript";
  toggle.style.cssText =
    "cursor: pointer; font-size: 0.9em; color: var(--muted);";
  const body = document.createElement("div");
  body.style.cssText = "margin-top: 6px;";
  details.appendChild(toggle);
  details.appendChild(body);

  let loaded = false;
  details.addEventListener("toggle", async () => {
    if (!details.open || loaded) {
      return;
    }
    loaded = true;
    body.textContent = "Loading transcript cues...";
    try {
      const response = await fetch("/api/clip-cues", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          mp3Path: buildDiscoverPayload().mp3Path,
          discoveryData: currentDiscoveryData?.discoveryData,
          startSeconds: suggestion.startSeconds,
          endSeconds: suggestion.endSeconds,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || "Cue request failed");
      }
      renderClipCueEditor(body, data);
    } catch (error) {
      loaded = false;
      body.textContent = `Could not load transcript cues: ${error.message}`;
    }
  });

  return details;
}

function renderClipCueEditor(container, { cues, editable }) {
  container.textContent = "";

  if (!cues.length) {
    container.textContent = "No subtitle cues in this clip's window.";
    return;
  }

  const originals = cues.map((cue) => cue.speech);
  const inputs = [];

  cues.forEach((cue) => {
    const row = document.createElement("div");
    row.style.cssText =
      "display: flex; gap: 8px; margin-bottom: 6px; align-items: baseline;";

    const label = document.createElement("span");
    label.textContent = `${formatCueTime(cue.startSeconds)}${cue.speaker ? ` ${cue.speaker}` : ""}`;
    label.style.cssText =
      "font-size: 0.8em; color: var(--muted); white-space: nowrap; min-width: 100px;";

    const input = document.createElement("textarea");
    input.value = cue.speech;
    input.rows = 1;
    input.disabled = !editable;
    input.style.cssText =
      "flex: 1; resize: vertical; font-size: 0.9em; line-height: 1.4;";
    inputs.push(input);

    row.appendChild(label);
    row.appendChild(input);
    container.appendChild(row);
  });

  if (!editable) {
    const note = document.createElement("div");
    note.textContent =
      "Editing needs the episode transcripts - press Approve first.";
    note.style.cssText = "font-size: 0.85em; color: var(--muted);";
    container.appendChild(note);
    return;
  }

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.textContent = "Save Transcript Edits";
  saveButton.style.marginTop = "6px";
  saveButton.addEventListener("click", async () => {
    const fixes = [];
    inputs.forEach((input, index) => {
      const edited = input.value.trim();
      if (edited && edited !== originals[index].trim()) {
        fixes.push({ quote: originals[index], correction: edited });
      }
    });
    if (!fixes.length) {
      addStatus("No transcript edits to save.");
      return;
    }

    saveButton.disabled = true;
    try {
      const response = await fetch("/api/transcript-review", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          mp3Path: buildDiscoverPayload().mp3Path,
          discoveryData: currentDiscoveryData?.discoveryData,
          recheck: false,
          transcriptFixes: fixes,
        }),
      });
      const bodyJson = await response.json();
      if (!response.ok || !bodyJson.success) {
        throw new Error(bodyJson.error || "Save failed");
      }

      renderTranscriptFixResult(bodyJson.fixes);
      addStatus(
        "✓ Transcript edits saved - regenerate clip videos to re-render with them",
      );
      // Applied rows become the new baseline; missed ones keep their original so a
      // retry still diffs against the real file content.
      const appliedQuotes = bodyJson.fixes?.appliedQuotes || [];
      inputs.forEach((input, index) => {
        if (appliedQuotes.includes(originals[index])) {
          originals[index] = input.value.trim();
        }
      });
    } catch (error) {
      addStatus(`❌ Saving transcript edits failed: ${error.message}`);
    } finally {
      saveButton.disabled = false;
    }
  });
  container.appendChild(saveButton);
}

function renderClipSuggestions(suggestions) {
  // Re-rendering replaces the card nodes, which would orphan a playing preview's
  // Stop button.
  stopClipPreview();
  currentClipSuggestions = Array.isArray(suggestions) ? suggestions : [];
  const nextApprovalState = [];

  currentClipSuggestions.forEach((_, index) => {
    nextApprovalState[index] = clipApprovalState[index] ?? true;
  });

  clipApprovalState = nextApprovalState;
  clipSuggestionsList.innerHTML = "";

  // The cards stay on screen during an MP4 render - the server queues generation
  // behind the render ("waiting" state), so clips can be reviewed and queued instead
  // of waiting for the render to finish. Only while the Approve request itself is in
  // flight is generation held back: the run rewrites the MP3 clips read from.
  clipQueueNote.style.display = isVideoRenderInProgress ? "block" : "none";
  generateClipVideosButton.style.display = "inline-block";
  generateClipVideosButton.disabled = isRunRequestInFlight;

  if (currentClipSuggestions.length === 0) {
    clipSuggestionsSection.style.display = "none";
    return;
  }

  clipSuggestionsSection.style.display = "block";
  // The count keeps the collapsed section informative; open/closed state is the
  // browser's and survives re-renders because only the list contents are replaced.
  clipSuggestionsSummary.textContent = `Clip Suggestions (${currentClipSuggestions.length})`;

  const chapters = getDiscoverySnapshot()?.chapters || [];

  currentClipSuggestions.forEach((suggestion, index) => {
    const card = document.createElement("div");
    card.style.cssText = `
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 10px;
      background: var(--panel-alt);
    `;

    const title = document.createElement("strong");
    title.textContent =
      suggestion.summary || suggestion.title || `Clip ${index + 1}`;
    title.style.display = "block";
    title.style.marginBottom = "6px";
    card.appendChild(title);

    const meta = document.createElement("div");
    meta.style.cssText =
      "font-size: 0.9em; color: var(--muted); margin-bottom: 8px;";
    const chapterTitle = chapterTitleForTime(chapters, suggestion.startSeconds);
    const metaParts = [
      suggestion.timestampLabel || "",
      `${Math.round(suggestion.durationSeconds || 0)}s`,
    ];
    if (chapterTitle) {
      metaParts.push(chapterTitle);
    }
    if (suggestion.speaker) {
      metaParts.push(`Opens with ${suggestion.speaker}`);
    }
    meta.textContent = metaParts.filter(Boolean).join(" • ");
    card.appendChild(meta);

    if (suggestion.reason) {
      const reasonBadge = document.createElement("span");
      reasonBadge.textContent = suggestion.reason;
      reasonBadge.style.cssText = `
        display: inline-block;
        font-size: 0.8em;
        color: var(--muted);
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 2px 10px;
        margin-bottom: 8px;
      `;
      card.appendChild(reasonBadge);
    }

    if (suggestion.llmReason) {
      const why = document.createElement("div");
      why.textContent = suggestion.llmReason;
      why.style.cssText =
        "font-size: 0.85em; color: var(--muted); margin-bottom: 8px;";
      card.appendChild(why);
    }

    if (
      typeof suggestion.startSeconds === "number" &&
      typeof suggestion.endSeconds === "number"
    ) {
      card.appendChild(buildClipTranscriptEditor(suggestion));
    }

    const controls = document.createElement("div");
    controls.style.cssText = "display:flex; gap:8px;";

    const previewButton = document.createElement("button");
    previewButton.type = "button";
    previewButton.textContent = "▶ Preview";
    previewButton.style.cssText = `
      padding: 8px 10px;
      cursor: pointer;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 4px;
    `;
    previewButton.addEventListener("click", () => {
      playClipPreview(suggestion, previewButton);
    });
    controls.appendChild(previewButton);

    const approved = clipApprovalState[index] !== false;
    const approveButton = document.createElement("button");
    approveButton.type = "button";
    approveButton.textContent = approved ? "✓ Approved" : "Approve";
    approveButton.style.cssText = `
      padding: 8px 10px;
      cursor: pointer;
      background: ${approved ? "#1f4d2b" : "var(--panel)"};
      color: ${approved ? "#fff" : "inherit"};
      border: 1px solid var(--line);
      border-radius: 4px;
    `;
    approveButton.addEventListener("click", () => {
      clipApprovalState[index] = true;
      renderClipSuggestions(currentClipSuggestions);
    });

    const denyButton = document.createElement("button");
    denyButton.type = "button";
    denyButton.textContent = approved ? "Deny" : "✕ Denied";
    denyButton.style.cssText = `
      padding: 8px 10px;
      cursor: pointer;
      background: ${approved ? "var(--panel)" : "#4f1c1c"};
      color: ${approved ? "inherit" : "#fff"};
      border: 1px solid var(--line);
      border-radius: 4px;
    `;
    denyButton.addEventListener("click", () => {
      clipApprovalState[index] = false;
      renderClipSuggestions(currentClipSuggestions);
    });

    controls.appendChild(approveButton);
    controls.appendChild(denyButton);
    card.appendChild(controls);
    clipSuggestionsList.appendChild(card);
  });
}

// Chapters are sorted by start time; a clip belongs to the last chapter that starts at
// or before it. Chapters without startSeconds (the trimmed discovery-response shape)
// are skipped rather than misattributed.
function chapterTitleForTime(chapters, seconds) {
  if (typeof seconds !== "number") {
    return null;
  }

  let title = null;
  for (const chapter of chapters || []) {
    if (typeof chapter.startSeconds !== "number") {
      continue;
    }
    if (chapter.startSeconds > seconds) {
      break;
    }
    title = chapter.title || null;
  }
  return title;
}

function clearClipSuggestionReviewPanel() {
  currentClipSuggestions = [];
  clipApprovalState = [];
  renderClipSuggestions([]);
}

function getApprovedClipSuggestions() {
  return currentClipSuggestions.filter(
    (_, index) => clipApprovalState[index] !== false,
  );
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

  resetStatus();
  isDiscovering = true;
  toggleOverridesButton.style.display = "none";
  currentTranscriptFindings = [];
  renderTranscriptFixSection();

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
    renderProfanityStatus(
      result.discovered?.transcriptChecks,
      "Discovery",
      payload.transcriptMdPath,
    );
    resumeVideoStatusPollingFromDiscover(result.discovered?.videoStatus);
    resumeClipStatusPollingFromDiscover(result.discovered?.videoStatus);

    currentDiscoveryData = {
      discoveryData: result.discoveryData,
    };
    setProcessActionsVisibility();
    currentRunResult = null;

    const videoStatusState = String(
      result.discovered?.videoStatus?.status || "",
    );
    const hasActiveVideoRun = videoStatusState === "started";
    const hasCompletedVideoRun = videoStatusState === "completed";

    setVideoRenderCompletedUiState(false);
    setVideoRenderUiState(hasActiveVideoRun);
    if (hasCompletedVideoRun) {
      setVideoRenderCompletedUiState(true);
    }

    // Suggestions the user already saw (from the last run or regenerate) come back
    // rather than forcing a regeneration, which re-picks and loses the old set. This
    // must run after the video-state calls above: setVideoRenderCompletedUiState hides
    // the whole clip section, and renderClipSuggestions re-shows it.
    const existingSuggestions =
      result.discovered?.existingClipSuggestions || [];
    clipApprovalState = [];
    renderClipSuggestions(existingSuggestions);
    if (existingSuggestions.length > 0 && !hasActiveVideoRun) {
      addStatus(
        `✓ Restored ${existingSuggestions.length} clip suggestion(s) from the last run`,
      );
    }

    // Shownotes links: the last run's edited list when there is one, otherwise the
    // auto-resolved Steam links as the starting point.
    const seedLinks = Array.isArray(result.discovered?.existingShownotesLinks)
      ? result.discovered.existingShownotesLinks
      : result.discovered?.shownotesLinkSeeds || [];
    shownotesLinks = seedLinks.map((link) => ({
      title: link.title || "",
      url: link.url || "",
    }));
    renderShownotesLinks();
    // Links are review-phase input: once a run has baked them into index.md the
    // editor stays hidden, like the chapter preview.
    if (!hasActiveVideoRun && !hasCompletedVideoRun) {
      shownotesLinksSection.style.display = "block";
    }

    // Unapplied medium-confidence findings come back the same way; ticks are keyed by
    // quote, so any made before the refresh carry over.
    const existingFindings =
      result.discovered?.existingTranscriptFindings || [];
    if (existingFindings.length > 0) {
      currentTranscriptFindings = existingFindings;
      renderTranscriptFixSection();
      addStatus(
        `⚠ Restored ${existingFindings.length} medium-confidence transcript suggestion(s) from the last run - review below`,
      );
    }

    if (hasActiveVideoRun) {
      addStatus(
        "⏳ MP4 render is already in progress; clip generation will be available when it completes.",
      );
    } else if (hasCompletedVideoRun) {
      addStatus("✓ MP4 generation is already complete for this episode.");
    } else {
      addStatus("✓ Chapter images ready for review");
    }

    if (!hasActiveVideoRun && !hasCompletedVideoRun) {
      toggleOverridesButton.style.display = "inline-block";
    }

    renderDiscoverySummary(result.discovered);
    discoverySummarySection.style.display = "block";
    if (!hasActiveVideoRun && !hasCompletedVideoRun) {
      renderChapterPreviews(result.discovered);
      previewSection.style.display = "block";
    }
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

async function pollVideoStatus(statusFile) {
  function formatEta(etaSeconds) {
    if (!Number.isFinite(Number(etaSeconds)) || Number(etaSeconds) < 0) {
      return "";
    }
    const total = Math.round(Number(etaSeconds));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes > 0) {
      return `, ETA ${minutes}m ${seconds}s`;
    }
    return `, ETA ${seconds}s`;
  }

  persistActiveVideoStatusFile(statusFile);

  function buildProgressDetail(data) {
    const percentSuffix =
      typeof data.percent === "number" ? ` (${data.percent}%)` : "";
    const etaSuffix = formatEta(data.etaSeconds);

    if (data.phase === "segments") {
      const current = Number.isFinite(Number(data.current))
        ? Number(data.current)
        : 0;
      const total = Number.isFinite(Number(data.total))
        ? Number(data.total)
        : 0;
      return `MP4 generation in progress... segment ${current}/${total}${percentSuffix}${etaSuffix}`;
    }

    if (data.phase === "concat") {
      return `MP4 generation in progress... concatenating segments${percentSuffix}${etaSuffix}`;
    }

    if (data.phase === "mux") {
      return `MP4 generation in progress... muxing audio/video${percentSuffix}${etaSuffix}`;
    }

    return `MP4 generation in progress...${percentSuffix}${etaSuffix}`;
  }

  let videoLineId = findStatusLineId("MP4 generation");
  if (videoLineId === null) {
    videoLineId = addStatus("| MP4 generation in progress... 0% (starting)");
  }

  const frames = ["|", "/", "-", "\\"];
  let frameIndex = 0;
  let latestPercent = 0;
  let latestDetail = "MP4 generation in progress...";
  let missingPolls = 0;
  const spinner = setInterval(() => {
    setStatusLine(
      videoLineId,
      `${frames[frameIndex % frames.length]} MP4 generation ${latestPercent}% - ${latestDetail}`,
    );
    frameIndex += 1;
  }, 250);

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    try {
      const res = await fetch(
        `/api/video-status?statusFile=${encodeURIComponent(statusFile)}`,
      );
      const data = await res.json();

      // A run that is starting writes its status file within moments, so repeated
      // misses mean the file is gone for good (deleted, or the episode folder was
      // renamed). Without this bail-out a stale persisted status file kept the UI in
      // "render in progress" - with every button disabled - forever.
      if (data.status === "missing") {
        missingPolls += 1;
        if (missingPolls >= 3) {
          clearInterval(spinner);
          persistActiveVideoStatusFile("");
          setVideoRenderUiState(false);
          setStatusLine(
            videoLineId,
            "ℹ The tracked MP4 render's status file no longer exists; cleared stale tracking.",
          );
          return { status: "missing" };
        }
        continue;
      }
      missingPolls = 0;

      if (data.status === "completed") {
        clearInterval(spinner);
        persistActiveVideoStatusFile("");
        setVideoRenderUiState(false);
        setVideoRenderCompletedUiState(true);
        // The completed-state call above hides the clip section, and the suggestions
        // from the run were stored (not shown) while the render was in flight - this
        // re-render is what puts the cards and the generate button on screen.
        renderClipSuggestions(currentClipSuggestions);
        setStatusLine(videoLineId, "✓ MP4 generation complete");
        return { status: "completed" };
      } else if (data.status === "failed") {
        clearInterval(spinner);
        persistActiveVideoStatusFile("");
        setVideoRenderUiState(false);
        setVideoRenderCompletedUiState(false);
        // Approve is enabled again after a failure, so what it acts on must be
        // visible too - otherwise the re-approve happens blind.
        previewSection.style.display = "block";
        shownotesLinksSection.style.display = "block";
        toggleOverridesButton.style.display = "inline-block";
        const interruptedByRestart =
          /interrupted \(server process restarted or exited\)/i.test(
            String(data.error || ""),
          );
        if (interruptedByRestart) {
          setStatusLine(
            videoLineId,
            "ℹ Previous MP4 generation was interrupted by a server restart. Start a new run to continue.",
          );
          return { status: "interrupted", error: data.error };
        }
        setStatusLine(videoLineId, `❌ MP4 generation failed: ${data.error}`);
        return { status: "failed", error: data.error };
      } else {
        if (typeof data.percent === "number") {
          latestPercent = Math.max(0, Math.min(100, Math.round(data.percent)));
        }
        latestDetail = buildProgressDetail(data);
        setStatusLine(
          videoLineId,
          `${frames[frameIndex % frames.length]} MP4 generation ${latestPercent}% - ${latestDetail}`,
        );
      }
      // still "started" or "pending" — keep polling
    } catch {
      // network error — keep polling
    }
  }

  // unreachable: loop returns on completion/failure states
}

// Checks the real status before claiming anything: a render that finished while the
// tab was closed used to greet the user with "Reconnected to in-progress MP4
// generation" and only correct itself after the first poll interval.
async function resumeVideoStatusPollingIfNeeded() {
  const statusFile = readPersistedVideoStatusFile();
  if (!statusFile) {
    return;
  }

  let status = null;
  try {
    const res = await fetch(
      `/api/video-status?statusFile=${encodeURIComponent(statusFile)}`,
    );
    status = await res.json();
  } catch {
    // Server briefly unreachable; the poller's own handling can sort it out.
  }

  if (!status || status.status === "started" || status.status === "pending") {
    startVideoStatusPolling(statusFile, {
      startMessage:
        "⏳ Reconnected to in-progress MP4 generation after refresh",
    });
    return;
  }

  // Terminal or missing: nothing to reconnect to. Discovery reads the same status
  // file for the current episode and reports it, so no extra message is needed.
  persistActiveVideoStatusFile("");
}

function resumeVideoStatusPollingFromDiscover(videoStatus) {
  if (!videoStatus || videoStatus.status !== "started") {
    return;
  }

  const statusFile = String(videoStatus.statusFile || "").trim();
  if (!statusFile) {
    return;
  }
  if (activeVideoStatusFile === statusFile) {
    return;
  }

  startVideoStatusPolling(statusFile, {
    startMessage:
      "⏳ Reconnected to in-progress MP4 generation from server status",
  });
}

async function pollClipGenerationStatus(statusFile) {
  persistActiveClipStatusFile(statusFile);

  let lineId = findStatusLineId("Clip generation");
  if (lineId === null) {
    lineId = addStatus("⏳ Clip generation queued...");
  }

  let missingPolls = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      const res = await fetch(
        `/api/video-status?statusFile=${encodeURIComponent(statusFile)}`,
      );
      const data = await res.json();
      const clip = data.clipGeneration;

      // The clip state is written before the queue endpoint even responds, so
      // repeatedly finding no file (or no clip state in it) means the tracked run's
      // file is gone - stop polling instead of holding the Cancel button forever.
      if (data.status === "missing" || !clip || !clip.status) {
        missingPolls += 1;
        if (missingPolls >= 3) {
          persistActiveClipStatusFile("");
          setStatusLine(
            lineId,
            "ℹ The tracked clip run's status is no longer available; cleared stale tracking.",
          );
          return { status: "missing" };
        }
        continue;
      }
      missingPolls = 0;

      if (clip.status === "waiting") {
        setStatusLine(
          lineId,
          `⏳ Clip generation waiting for MP4 render... ${clip.current || 0}/${clip.total || 0} done (${clip.remaining || clip.total || 0} remaining)`,
        );
        continue;
      }

      if (clip.status === "started") {
        setStatusLine(
          lineId,
          `⏳ Clip generation ${clip.percent || 0}% - ${clip.current || 0}/${clip.total || 0} done (${clip.remaining || 0} remaining)`,
        );
        continue;
      }

      if (clip.status === "completed") {
        persistActiveClipStatusFile("");
        setStatusLine(
          lineId,
          `✓ Clip generation complete - ${clip.current || 0}/${clip.total || 0} done`,
        );
        return { status: "completed", clipGeneration: clip };
      }

      if (clip.status === "failed") {
        persistActiveClipStatusFile("");
        setStatusLine(
          lineId,
          `❌ Clip generation failed after ${clip.current || 0}/${clip.total || 0} done`,
        );
        addStatus(
          `❌ Clip generation failed: ${clip.error || "Unknown error"}`,
        );
        return { status: "failed", clipGeneration: clip };
      }

      if (clip.status === "cancelled") {
        persistActiveClipStatusFile("");
        setStatusLine(
          lineId,
          `⏹ Clip generation cancelled after ${clip.current || 0}/${clip.total || 0} clip(s) finished`,
        );
        return { status: "cancelled", clipGeneration: clip };
      }
    } catch {
      // keep polling
    }
  }
}

function startClipStatusPolling(statusFile, { startMessage = "" } = {}) {
  const normalizedStatusFile = String(statusFile || "").trim();
  if (!normalizedStatusFile) {
    return Promise.resolve({ status: "pending" });
  }

  if (
    activeClipStatusPoll &&
    activeClipStatusPoll.statusFile === normalizedStatusFile
  ) {
    return activeClipStatusPoll.promise;
  }

  activeClipStatusFile = normalizedStatusFile;
  cancelClipsButton.style.display = "inline-block";
  cancelClipsButton.disabled = false;
  if (startMessage) {
    addStatus(startMessage);
  }

  const pollPromise = pollClipGenerationStatus(normalizedStatusFile).finally(
    () => {
      if (
        activeClipStatusPoll &&
        activeClipStatusPoll.statusFile === normalizedStatusFile
      ) {
        activeClipStatusPoll = null;
      }
      if (activeClipStatusFile === normalizedStatusFile) {
        activeClipStatusFile = null;
        cancelClipsButton.style.display = "none";
      }
      isGeneratingClips = false;
    },
  );

  activeClipStatusPoll = {
    statusFile: normalizedStatusFile,
    promise: pollPromise,
  };

  return pollPromise;
}

async function resumeClipStatusPollingIfNeeded() {
  const statusFile = readPersistedClipStatusFile();
  if (!statusFile) {
    return;
  }

  let data = null;
  try {
    const res = await fetch(
      `/api/video-status?statusFile=${encodeURIComponent(statusFile)}`,
    );
    data = await res.json();
  } catch {
    // Server briefly unreachable; the poller's own handling can sort it out.
  }

  const clip = data?.clipGeneration;
  if (!data || (clip && ["waiting", "started"].includes(clip.status))) {
    startClipStatusPolling(statusFile, {
      startMessage:
        "⏳ Reconnected to queued/in-progress clip generation after refresh",
    });
    return;
  }

  persistActiveClipStatusFile("");
  if (clip?.status === "completed") {
    addStatus(
      `✓ Clip generation finished while the tab was closed (${clip.current || 0}/${clip.total || 0} clips).`,
    );
  } else if (clip?.status === "failed") {
    addStatus(
      `❌ The tracked clip generation failed: ${clip.error || "unknown error"}`,
    );
  } else if (clip?.status === "cancelled") {
    addStatus("⏹ The tracked clip generation was cancelled.");
  }
}

function resumeClipStatusPollingFromDiscover(videoStatus) {
  const clip = videoStatus?.clipGeneration;
  if (!clip || !["waiting", "started"].includes(clip.status)) {
    return;
  }

  const statusFile = String(videoStatus.statusFile || "").trim();
  if (!statusFile || activeClipStatusFile === statusFile) {
    return;
  }

  startClipStatusPolling(statusFile, {
    startMessage:
      "⏳ Reconnected to queued/in-progress clip generation from server status",
  });
}

function startVideoStatusPolling(
  statusFile,
  { startMessage = "", onComplete = null } = {},
) {
  const normalizedStatusFile = String(statusFile || "").trim();
  if (!normalizedStatusFile) {
    return Promise.resolve({ status: "pending" });
  }

  if (
    activeVideoStatusPoll &&
    activeVideoStatusPoll.statusFile === normalizedStatusFile
  ) {
    if (typeof onComplete === "function") {
      activeVideoStatusPoll.promise.then(onComplete);
    }
    return activeVideoStatusPoll.promise;
  }

  activeVideoStatusFile = normalizedStatusFile;
  setVideoRenderUiState(true);
  if (startMessage) {
    addStatus(startMessage);
  }

  const pollPromise = pollVideoStatus(normalizedStatusFile).finally(() => {
    if (
      activeVideoStatusPoll &&
      activeVideoStatusPoll.statusFile === normalizedStatusFile
    ) {
      activeVideoStatusPoll = null;
    }
    if (activeVideoStatusFile === normalizedStatusFile) {
      activeVideoStatusFile = null;
    }
  });

  activeVideoStatusPoll = {
    statusFile: normalizedStatusFile,
    promise: pollPromise,
  };

  if (typeof onComplete === "function") {
    pollPromise.then(onComplete);
  }

  return pollPromise;
}

restartProcessButton.addEventListener("click", async () => {
  if (isVideoRenderInProgress) {
    addStatus(
      "MP4 render is currently in progress. Wait for completion before restarting.",
    );
    return;
  }
  // A restart mid-clip-generation would clear the UI while the server keeps rendering,
  // orphaning a run that can no longer be watched or cancelled from here.
  if (isGeneratingClips || activeClipStatusFile) {
    addStatus(
      "Clip generation is in progress. Cancel it or wait for it to finish before restarting.",
    );
    return;
  }

  const confirmed = window.confirm(
    "Clear and restart process? This resets the episode's processing state: run status, suggestions, applied-fix memory, saved links and temporary overrides. Generated media files are not deleted.",
  );
  if (!confirmed) {
    addStatus("Clear & Restart cancelled.");
    return;
  }

  // The server-side half: discovery restores completed-run state, suggestions, links
  // and fix memory from the episode's status file and report, so those must go too or
  // the restart resurrects everything.
  if (currentDiscoveryData?.discoveryData) {
    try {
      const response = await fetch("/api/clear-episode-state", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          mp3Path: buildDiscoverPayload().mp3Path,
          discoveryData: currentDiscoveryData.discoveryData,
        }),
      });
      const body = await response.json();
      if (!response.ok || !body.success) {
        throw new Error(body.error || "Clear request failed");
      }
    } catch (error) {
      addStatus(`❌ Could not clear episode state: ${error.message}`);
      return;
    }
  }

  currentRunResult = null;
  currentClipSuggestions = [];
  clipApprovalState = [];
  chapterImageOverrides = {};
  currentTranscriptFindings = [];
  mediumFixAccepted = {};
  shownotesLinks = [];
  renderTranscriptFixSection();
  persistActiveVideoStatusFile("");
  persistActiveClipStatusFile("");
  resetStatus();
  addStatus("↺ Process state cleared. Re-running discovery...");
  await runDiscovery();
});

rerenderMp4Button.addEventListener("click", async () => {
  if (isVideoRenderInProgress) {
    addStatus("MP4 render is already in progress.");
    return;
  }

  const discoverySnapshot = getDiscoverySnapshot();
  const formData = new FormData(form);
  const mp3Path = String(formData.get("mp3Path") || "").trim();

  if (!discoverySnapshot || !mp3Path) {
    addStatus("❌ Missing discovery or MP3 data. Run discovery first.");
    return;
  }

  rerenderMp4Button.disabled = true;
  try {
    const response = await fetch("/api/rerender-mp4", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mp3Path,
        discoveryData: currentDiscoveryData.discoveryData,
      }),
    });
    const body = await response.json();
    if (!response.ok || !body.success || !body.videoStatus?.statusFile) {
      throw new Error(body.error || "Failed to start MP4 re-render");
    }

    clearClipSuggestionReviewPanel();
    startVideoStatusPolling(body.videoStatus.statusFile, {
      startMessage: "⏳ MP4 re-render started...",
    });
  } catch (error) {
    addStatus(`❌ Failed to start MP4 re-render: ${error.message}`);
  } finally {
    if (!isVideoRenderInProgress) {
      rerenderMp4Button.disabled = false;
    }
  }
});

regenerateClipsButton.addEventListener("click", async () => {
  if (!currentDiscoveryData?.discoveryData) {
    addStatus("Run discovery first.");
    return;
  }

  regenerateClipsButton.disabled = true;
  const stopSpinner = startStatusSpinner("Regenerating clip suggestions...");
  try {
    const response = await fetch("/api/clip-suggestions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mp3Path: buildDiscoverPayload().mp3Path,
        discoveryData: currentDiscoveryData.discoveryData,
      }),
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.error || "Failed to regenerate clip suggestions");
    }

    stopSpinner("✓ Clip suggestions regenerated");
    if (result.warning) {
      addStatus(
        `⚠ AI clip selection unavailable (${result.warning}) — showing heuristic suggestions`,
      );
    }
    // Fresh suggestions get fresh approvals; carrying old ones over by index would
    // approve different clips than the ones the user looked at.
    clipApprovalState = [];
    renderClipSuggestions(result.clipSuggestions || []);
    addStatus(
      result.source === "llm"
        ? "✓ AI clip suggestions ready for review."
        : "✓ Heuristic clip suggestions ready for review.",
    );
  } catch (error) {
    stopSpinner();
    addStatus(`❌ Failed to regenerate clip suggestions: ${error.message}`);
  } finally {
    regenerateClipsButton.disabled = false;
  }
});

async function executeClipGenerationRequest(request) {
  if (!request || isGeneratingClips) {
    return;
  }

  const suggestions = Array.isArray(request.clipSuggestions)
    ? request.clipSuggestions
    : [];
  if (!suggestions.length) {
    addStatus("No approved clip suggestions to generate.");
    return;
  }

  isGeneratingClips = true;

  try {
    const response = await fetch("/api/generate-clip-videos", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...request,
        discoveryData: currentDiscoveryData?.discoveryData,
      }),
    });

    const body = await response.json();
    if (!response.ok || !body.success || !body.clipStatusFile) {
      throw new Error(body.error || "Failed to queue clip generation");
    }

    startClipStatusPolling(body.clipStatusFile, {
      startMessage: "⏳ Clip generation queued on server...",
    });
  } catch (error) {
    addStatus(`❌ Clip generation failed: ${error.message}`);
    isGeneratingClips = false;
  }
}

// Both buttons hit the same endpoint against the episode's written transcripts, but
// each does exactly what its label says: apply sends only the ticked
// medium-confidence fixes; recheck re-runs the AI review of the current file contents
// (auto-applying high-confidence findings) and leaves the ticks for the apply button.
async function postTranscriptReview({ recheck }) {
  if (!currentDiscoveryData?.discoveryData) {
    addStatus("Run discovery first.");
    return;
  }
  const ticked = recheck ? [] : getTickedTranscriptFixes();
  if (!recheck && ticked.length === 0) {
    addStatus("No transcript fixes ticked.");
    return;
  }

  applyTranscriptFixesButton.disabled = true;
  recheckTranscriptButton.disabled = true;
  const stopSpinner = startStatusSpinner(
    recheck
      ? "Re-running AI transcript check..."
      : "Applying ticked transcript fixes...",
  );

  try {
    const response = await fetch("/api/transcript-review", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mp3Path: buildDiscoverPayload().mp3Path,
        discoveryData: currentDiscoveryData.discoveryData,
        recheck,
        transcriptFixes: ticked,
      }),
    });
    const body = await response.json();
    if (!response.ok || !body.success) {
      throw new Error(body.error || "Transcript review request failed");
    }

    stopSpinner(
      recheck ? "✓ AI transcript check finished" : "✓ Ticked fixes applied",
    );

    const appliedQuotes = body.fixes?.appliedQuotes || [];
    if (body.review) {
      currentTranscriptFindings = (body.review.findings || []).filter(
        (finding) =>
          finding.confidence !== "high" &&
          !appliedQuotes.includes(finding.quote),
      );
      if ((body.review.findings || []).length === 0) {
        addStatus("✓ AI transcript check: no likely mistranscriptions found");
      }
    } else {
      currentTranscriptFindings = currentTranscriptFindings.filter(
        (finding) => !appliedQuotes.includes(finding.quote),
      );
    }

    renderTranscriptFixResult(body.fixes);
    if (currentTranscriptFindings.length > 0) {
      addStatus(
        `⚠ ${currentTranscriptFindings.length} medium-confidence suggestion(s) need review below`,
      );
    }
    renderTranscriptFixSection();
  } catch (error) {
    stopSpinner();
    addStatus(`❌ Transcript review failed: ${error.message}`);
  } finally {
    applyTranscriptFixesButton.disabled = false;
    recheckTranscriptButton.disabled = false;
  }
}

cancelClipsButton.addEventListener("click", async () => {
  if (!activeClipStatusFile) {
    addStatus("No clip generation in progress.");
    return;
  }

  cancelClipsButton.disabled = true;
  try {
    const response = await fetch("/api/cancel-clip-generation", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ statusFile: activeClipStatusFile }),
    });
    const body = await response.json();
    if (!response.ok || !body.success) {
      // Clicking Cancel just as the run completes is a benign race, not a failure.
      if (/no clip generation in progress/i.test(body.error || "")) {
        addStatus("ℹ Clip generation already finished; nothing to cancel.");
        return;
      }
      throw new Error(body.error || "Cancel request failed");
    }
    // The poller reports the actual "cancelled" state once the server has killed
    // ffmpeg and written it; this line just acknowledges the click immediately.
    addStatus("⏹ Cancelling clip generation...");
  } catch (error) {
    cancelClipsButton.disabled = false;
    addStatus(`❌ Cancel failed: ${error.message}`);
  }
});

applyTranscriptFixesButton.addEventListener("click", () => {
  postTranscriptReview({ recheck: false });
});

recheckTranscriptButton.addEventListener("click", () => {
  postTranscriptReview({ recheck: true });
});

approveButton.addEventListener("click", async () => {
  approveButton.disabled = true;
  toggleOverridesButton.style.display = "none";
  isRunRequestInFlight = true;
  setVideoRenderUiState(true);
  resetStatus();
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
    if (
      !runPayload.mp3Path ||
      !runPayload.transcriptMdPath ||
      !runPayload.transcriptVttPath
    ) {
      throw new Error("Missing MP3/transcript paths for run");
    }

    // Always rediscover from disk before run so transcript edits are reflected.
    const freshDiscoveryResponse = await fetch("/api/discover", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mp3Path: runPayload.mp3Path,
        transcriptMdPath: runPayload.transcriptMdPath,
        transcriptVttPath: runPayload.transcriptVttPath,
        episodeTitle: runPayload.episodeTitle,
        description: runPayload.description,
        publishDate: runPayload.publishDate,
      }),
    });

    const freshDiscoveryBody = await freshDiscoveryResponse.json();
    if (!freshDiscoveryResponse.ok || !freshDiscoveryBody.success) {
      throw new Error(
        freshDiscoveryBody.error || "Failed to refresh discovery data",
      );
    }

    let discoveryData = freshDiscoveryBody.discoveryData;
    currentDiscoveryData = {
      discoveryData,
    };
    addStatus("✓ Refreshed discovery data from transcript and chapter files");

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
        shownotesLinks,
      }),
    });

    const result = await response.json();
    const runFailed = !response.ok || Boolean(result.error);
    stopRunSpinner(
      runFailed ? "❌ Generation failed" : "✓ Generation completed",
    );
    currentRunResult = result;
    if (result.clipSource === "llm") {
      addStatus(
        `✓ Clip suggestions picked by AI (${(result.clipSuggestions || []).length})`,
      );
    }
    // The run's suggestions replace whatever set was on screen before, so approvals
    // must not carry over by index onto different clips.
    clipApprovalState = [];
    renderClipSuggestions(result.clipSuggestions || []);
    activeVideoStatusFile = null;

    if (runFailed) {
      // The approve click set the in-progress state up front; without unwinding it
      // here every action button (restart included) stays disabled until a refresh.
      setVideoRenderUiState(false);
      addStatus(
        `❌ Error: ${result.error || `Request failed (${response.status})`}`,
      );
    } else {
      renderProfanityStatus(
        result.transcriptChecks,
        "Run",
        runPayload.transcriptMdPath,
      );
      renderTranscriptFixResult(result.transcriptFixes);
      renderTranscriptReview(result.transcriptReview);
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
        persistActiveVideoStatusFile("");
        setVideoRenderUiState(false);
        // The earlier render happened while the video-in-progress state still hid the
        // section; with no render coming, show the cards now.
        renderClipSuggestions(currentClipSuggestions);
        addStatus("✓ MP4 generation skipped");
      } else if (result.videoStatus && result.videoStatus.statusFile) {
        activeVideoStatusFile = result.videoStatus.statusFile;
        setVideoRenderUiState(true);
        startVideoStatusPolling(result.videoStatus.statusFile, {
          startMessage: "⏳ MP4 generation in progress... (0%)",
        });
      } else {
        setVideoRenderUiState(false);
      }
    }
  } catch (error) {
    setVideoRenderUiState(false);
    if (stopRunSpinner) {
      stopRunSpinner();
    }
    addStatus(`❌ Request failed: ${error.message}`);
  } finally {
    isRunRequestInFlight = false;
    renderClipSuggestions(currentClipSuggestions);
    if (!isVideoRenderInProgress) {
      approveButton.disabled = false;
    }
  }
});

toggleOverridesButton.addEventListener("click", () => {
  const showing = form.style.display !== "none";
  form.style.display = showing ? "none" : "block";
  toggleOverridesButton.textContent = showing
    ? "Show Overrides"
    : "Hide Overrides";
});

generateClipVideosButton.addEventListener("click", async () => {
  // Checked before the panel is cleared below - executeClipGenerationRequest's own
  // guard returns silently, which would eat the suggestions with no feedback.
  if (isGeneratingClips) {
    addStatus("Clip generation is already in progress.");
    return;
  }

  const approvedSuggestions = getApprovedClipSuggestions();
  if (!approvedSuggestions.length) {
    addStatus("No approved clip suggestions to generate.");
    return;
  }

  const outputDirectory = currentRunResult?.episode?.outputDirectory;
  const imagePath = currentRunResult?.coverImagePath;
  const formData = new FormData(form);
  const mp3Path = String(formData.get("mp3Path") || "").trim();

  const requestPayload = {
    clipSuggestions: approvedSuggestions,
    outputDirectory,
    imagePath,
    mp3Path,
  };

  // Immediately hide the generate button to prevent duplicate requests.
  generateClipVideosButton.style.display = "none";
  clearClipSuggestionReviewPanel();

  executeClipGenerationRequest(requestPayload);
});

prefillFromQuery();
runDiscovery().finally(() => {
  resumeVideoStatusPollingIfNeeded();
  resumeClipStatusPollingIfNeeded();
});
