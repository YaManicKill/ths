// Minimal WebVTT reader: just cue timings and plain text, which is all clip-boundary
// snapping and subtitle burning need.

// "00:16:11.280" or the spec's hourless "16:11.280".
function parseVttTimestamp(value) {
  const match = /^(?:(\d{1,4}):)?(\d{1,2}):(\d{2})\.(\d{3})$/.exec(
    String(value || "").trim(),
  );
  if (!match) {
    return null;
  }

  const [, hours, minutes, seconds, milliseconds] = match;
  return (
    Number(hours || 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(milliseconds) / 1000
  );
}

function stripCueMarkup(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseVttCues(vttText) {
  // Blocks are separated by blank lines; anything without a "-->" line (the WEBVTT
  // header, STYLE and NOTE blocks) is not a cue.
  const blocks = String(vttText || "")
    .replace(/^﻿/, "")
    .split(/\r?\n\r?\n/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) {
      continue;
    }

    const [rawStart, rawRest] = lines[timingIndex].split("-->");
    // Trailing cue settings ("align:start position:0%") follow the end timestamp.
    const rawEnd = String(rawRest || "")
      .trim()
      .split(/\s+/)[0];
    const startSeconds = parseVttTimestamp(rawStart);
    const endSeconds = parseVttTimestamp(rawEnd);
    if (
      startSeconds === null ||
      endSeconds === null ||
      endSeconds <= startSeconds
    ) {
      continue;
    }

    cues.push({
      startSeconds,
      endSeconds,
      text: stripCueMarkup(lines.slice(timingIndex + 1).join(" ")),
    });
  }

  cues.sort((a, b) => a.startSeconds - b.startSeconds);
  return cues;
}

module.exports = {
  parseVttCues,
  parseVttTimestamp,
  stripCueMarkup,
};
