const fs = require("node:fs");
const path = require("node:path");
const { normalizeTitle } = require("./utils");
const { runCommand } = require("./utils");

function parseEpisodeFromMp3Path(mp3Path) {
  const base = path.basename(mp3Path);
  const match = base.match(/^ths-(\d{2})-(\d{2})\.mp3$/i);
  if (!match) {
    throw new Error("MP3 filename must match ths-SS-EE.mp3");
  }

  return {
    seasonCode: match[1],
    episodeCode: match[2],
    seasonNumber: String(Number(match[1])),
    episodeNumber: String(Number(match[2])),
    guid: `ths-${match[1]}-${match[2]}`,
  };
}

function parseTimeToSeconds(input) {
  const value = String(input || "").trim();
  if (!value) {
    return null;
  }

  const parts = value.split(":").map((item) => item.trim());
  if (parts.some((item) => item === "" || Number.isNaN(Number(item)))) {
    return null;
  }

  if (parts.length === 2) {
    const [mm, ss] = parts.map(Number);
    return mm * 60 + ss;
  }

  if (parts.length === 3) {
    const [hh, mm, ss] = parts.map(Number);
    return hh * 3600 + mm * 60 + ss;
  }

  return null;
}

function formatSecondsToHhmmss(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hh = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function parseChapterFile(contents) {
  const lines = String(contents || "").split(/\r?\n/);
  const chapters = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s*[:\-]\s*(.+)$/);
    if (!match) {
      continue;
    }

    const startSeconds = parseTimeToSeconds(match[1]);
    if (startSeconds === null) {
      continue;
    }

    // Check for hidden chapter marker: leading * or [hidden] tag
    const titleRaw = match[2].trim();
    const isHidden =
      titleRaw.startsWith("*") || titleRaw.toLowerCase().includes("[hidden]");
    const title = titleRaw
      .replace(/^\*\s*/, "")
      .replace(/\s*\[hidden\]/gi, "")
      .trim();

    chapters.push({
      startSeconds,
      timeLabel: formatSecondsToHhmmss(startSeconds),
      title,
      normalizedTitle: normalizeTitle(title),
      hidden: isHidden,
    });
  }

  chapters.sort((a, b) => a.startSeconds - b.startSeconds);

  return chapters;
}

function parseBooleanish(value) {
  if (value === true || value === false) {
    return value;
  }

  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return null;
}

function chapterHiddenFromMetadata(chapter) {
  const tags = chapter && chapter.tags ? chapter.tags : {};
  const possibleValues = [
    chapter && chapter.hidden,
    chapter && chapter.is_hidden,
    chapter && chapter.visibility,
    chapter && chapter.disposition && chapter.disposition.hidden,
    chapter && chapter.disposition && chapter.disposition.enabled,
    tags.hidden,
    tags.HIDDEN,
    tags.is_hidden,
    tags.chapter_hidden,
    tags["chapter-hidden"],
    tags["com.apple.iTunes:hidden"],
    tags["com.apple.iTunes:chapter-hidden"],
    tags.enabled,
    tags.ENABLED,
  ];

  for (const rawValue of possibleValues) {
    const parsed = parseBooleanish(rawValue);
    if (parsed === null) {
      continue;
    }

    if (rawValue === tags.enabled || rawValue === tags.ENABLED) {
      return parsed === false;
    }

    if (
      rawValue === chapter.disposition?.enabled ||
      rawValue === chapter?.disposition?.enabled
    ) {
      return parsed === false;
    }

    return parsed;
  }

  return false;
}

function chapterTocFromMetadata(chapter) {
  const tags = chapter && chapter.tags ? chapter.tags : {};
  const possibleValues = [
    chapter && chapter.toc,
    chapter && chapter.in_toc,
    chapter && chapter.is_toc,
    chapter && chapter.disposition && chapter.disposition.toc,
    tags.toc,
    tags.TOC,
    tags.in_toc,
    tags["chapter-toc"],
    tags["chapter_toc"],
    tags["com.apple.iTunes:toc"],
    tags["com.apple.iTunes:chapter-toc"],
  ];

  for (const rawValue of possibleValues) {
    const parsed = parseBooleanish(rawValue);
    if (parsed === null) {
      continue;
    }
    return parsed;
  }

  return null;
}

function readSyncSafeInt(buffer, offset) {
  return (
    ((buffer[offset] & 0x7f) << 21) |
    ((buffer[offset + 1] & 0x7f) << 14) |
    ((buffer[offset + 2] & 0x7f) << 7) |
    (buffer[offset + 3] & 0x7f)
  );
}

function readNullTerminatedLatin1(buffer, start, end) {
  let cursor = start;
  while (cursor < end && buffer[cursor] !== 0x00) {
    cursor += 1;
  }
  return {
    value: buffer.toString("latin1", start, cursor),
    next: Math.min(cursor + 1, end),
  };
}

function parseId3ChapterVisibility(mp3Path) {
  let fd;
  try {
    fd = fs.openSync(mp3Path, "r");
    const header = Buffer.alloc(10);
    const headerRead = fs.readSync(fd, header, 0, 10, 0);
    if (headerRead !== 10 || header.toString("latin1", 0, 3) !== "ID3") {
      return new Map();
    }

    const version = header[3];
    const flags = header[5];
    const tagSize = readSyncSafeInt(header, 6);
    const tagBuffer = Buffer.alloc(tagSize);
    const tagRead = fs.readSync(fd, tagBuffer, 0, tagSize, 10);
    if (tagRead <= 0) {
      return new Map();
    }

    let offset = 0;
    if (flags & 0x40) {
      if (version === 4) {
        const extSize = readSyncSafeInt(tagBuffer, 0);
        offset += extSize;
      } else {
        const extSize = tagBuffer.readUInt32BE(0);
        offset += 4 + extSize;
      }
    }

    const chapById = new Map();
    const topLevelChildren = new Set();
    let sawTopLevelCtoc = false;

    while (offset + 10 <= tagRead) {
      const frameId = tagBuffer.toString("latin1", offset, offset + 4);
      if (!/^[A-Z0-9]{4}$/.test(frameId)) {
        break;
      }

      const frameSize =
        version === 4
          ? readSyncSafeInt(tagBuffer, offset + 4)
          : tagBuffer.readUInt32BE(offset + 4);
      const frameStart = offset + 10;
      const frameEnd = frameStart + frameSize;
      if (frameSize <= 0 || frameEnd > tagRead) {
        break;
      }

      if (frameId === "CHAP") {
        const idField = readNullTerminatedLatin1(
          tagBuffer,
          frameStart,
          frameEnd,
        );
        const cursor = idField.next;
        if (cursor + 16 <= frameEnd) {
          const startTimeMs = tagBuffer.readUInt32BE(cursor);
          chapById.set(idField.value, {
            id: idField.value,
            startSeconds: startTimeMs / 1000,
          });
        }
      }

      if (frameId === "CTOC") {
        const idField = readNullTerminatedLatin1(
          tagBuffer,
          frameStart,
          frameEnd,
        );
        let cursor = idField.next;
        if (cursor + 2 <= frameEnd) {
          const flagsByte = tagBuffer[cursor];
          const childCount = tagBuffer[cursor + 1];
          cursor += 2;

          const isTopLevel = Boolean(flagsByte & 0x2);
          const childIds = [];
          for (let i = 0; i < childCount && cursor < frameEnd; i += 1) {
            const childField = readNullTerminatedLatin1(
              tagBuffer,
              cursor,
              frameEnd,
            );
            childIds.push(childField.value);
            cursor = childField.next;
          }

          if (isTopLevel) {
            sawTopLevelCtoc = true;
            for (const childId of childIds) {
              topLevelChildren.add(childId);
            }
          }
        }
      }

      offset = frameEnd;
    }

    if (chapById.size === 0 || !sawTopLevelCtoc) {
      return new Map();
    }

    const hiddenByStartKey = new Map();
    for (const chap of chapById.values()) {
      const startKey = String(Math.round(chap.startSeconds * 1000));
      hiddenByStartKey.set(startKey, !topLevelChildren.has(chap.id));
    }

    return hiddenByStartKey;
  } catch {
    return new Map();
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

function parseChaptersFromMp3(mp3Path) {
  const result = runCommand("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_chapters",
    mp3Path,
  ]);

  if (result.status !== 0) {
    throw new Error(
      `ffprobe chapter read failed: ${result.stderr || result.stdout}`,
    );
  }

  const parsed = JSON.parse(result.stdout || "{}");
  const chapters = Array.isArray(parsed.chapters) ? parsed.chapters : [];
  const hiddenByStartKey = parseId3ChapterVisibility(mp3Path);

  return chapters
    .map((chapter, index) => {
      const startSeconds = Number(chapter.start_time);
      if (!Number.isFinite(startSeconds)) {
        return null;
      }

      const rawTitle =
        (chapter.tags && (chapter.tags.title || chapter.tags.TITLE)) ||
        `Chapter ${index + 1}`;
      const title = String(rawTitle).trim();

      const hidden =
        hiddenByStartKey.get(String(Math.round(startSeconds * 1000))) ??
        chapterHiddenFromMetadata(chapter);
      const tocFromMetadata = chapterTocFromMetadata(chapter);

      return {
        startSeconds,
        timeLabel: formatSecondsToHhmmss(startSeconds),
        title,
        normalizedTitle: normalizeTitle(title),
        hidden,
        toc: tocFromMetadata === null ? !hidden : tocFromMetadata,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.startSeconds - b.startSeconds);
}

function attachChapterDurations(chapters, totalDurationSeconds) {
  return chapters.map((chapter, index) => {
    const next = chapters[index + 1];
    const endSeconds = next ? next.startSeconds : totalDurationSeconds;
    return {
      ...chapter,
      endSeconds,
      durationSeconds: Math.max(0, endSeconds - chapter.startSeconds),
    };
  });
}

function episodeTitleFromChapterFilename(chapterPath, explicitTitle) {
  if (explicitTitle) {
    return explicitTitle.trim();
  }

  const base = path.basename(chapterPath);
  const normalizedBase = base.replace(/\u00a0/g, " ");
  return normalizedBase
    .replace(/\s*[\-\u2013\u2014]\s*Chapter Info\.txt$/i, "")
    .trim();
}

function episodeTitleFromInputs({ explicitTitle, transcriptMdPath, mp3Path }) {
  if (explicitTitle) {
    return explicitTitle.trim();
  }

  if (transcriptMdPath) {
    return path
      .basename(transcriptMdPath, path.extname(transcriptMdPath))
      .trim();
  }

  if (mp3Path) {
    return path.basename(mp3Path, path.extname(mp3Path)).trim();
  }

  return "Untitled Episode";
}

function extractSpeakerNames(transcriptMdText, maxNames = 2) {
  const names = [];
  const seen = new Set();
  const regex = /\*\*([^:*]+):\*\*/g;
  let match;

  while ((match = regex.exec(transcriptMdText)) !== null) {
    const name = match[1].trim();
    if (!name || seen.has(name.toLowerCase())) {
      continue;
    }
    seen.add(name.toLowerCase());
    names.push(name);
    if (names.length >= maxNames) {
      break;
    }
  }

  return names;
}

function extractUrls(...blocks) {
  const urlRegex = /https?:\/\/[^\s)\]>"']+/gi;
  const urls = new Set();

  for (const block of blocks) {
    const text = String(block || "");
    const found = text.match(urlRegex) || [];
    for (let url of found) {
      while (/[.,;!?]$/.test(url)) {
        url = url.slice(0, -1);
      }
      urls.add(url);
    }
  }

  return Array.from(urls);
}

module.exports = {
  attachChapterDurations,
  episodeTitleFromInputs,
  episodeTitleFromChapterFilename,
  extractSpeakerNames,
  extractUrls,
  formatSecondsToHhmmss,
  parseChaptersFromMp3,
  parseChapterFile,
  parseEpisodeFromMp3Path,
  parseTimeToSeconds,
};
