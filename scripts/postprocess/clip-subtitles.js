const fs = require("node:fs");
const path = require("node:path");

// libass matches fonts by family name, and fontconfig on macOS resolves "Arial Bold" to
// the wrong face entirely, so rendering uses fontsdir (the resolved bold font's
// directory) plus the family name that file actually carries.
const SUBTITLE_FONT_FAMILY = {
  darwin: "Arial",
  linux: "DejaVu Sans",
  win32: "Arial",
};

function subtitleFontFamilyForPlatform(platform = process.platform) {
  return SUBTITLE_FONT_FAMILY[platform] || SUBTITLE_FONT_FAMILY.linux;
}

// Cue text starts with the transcriber's "Speaker: " prefix, which reads as clutter when
// burned into a clip.
function stripSpeakerPrefix(text) {
  return String(text || "")
    .replace(/^[A-Za-z][\w'-]{0,19}:\s+/, "")
    .trim();
}

// Cues overlapping [clipStartSeconds, clipEndSeconds], rebased so 0 is the clip start and
// clamped to the clip, ready to become subtitle events.
function sliceCuesForClip({ cues, clipStartSeconds, clipEndSeconds }) {
  const sliced = [];

  for (const cue of cues || []) {
    if (
      cue.endSeconds <= clipStartSeconds ||
      cue.startSeconds >= clipEndSeconds
    ) {
      continue;
    }

    const text = stripSpeakerPrefix(cue.text);
    if (!text) {
      continue;
    }

    sliced.push({
      startSeconds: Math.max(0, cue.startSeconds - clipStartSeconds),
      endSeconds: Math.min(
        clipEndSeconds - clipStartSeconds,
        cue.endSeconds - clipStartSeconds,
      ),
      text,
    });
  }

  return sliced;
}

// ASS timestamps are H:MM:SS.cc (centiseconds). Rounding happens on the total
// centisecond count before the fields are split out: rounding the fraction on its own
// turns .995+ into a three-digit "100" field, producing timestamps that read earlier
// than intended (12.996 -> "0:00:12.100", i.e. 12.10s) instead of rolling the second.
function formatAssTimestamp(seconds) {
  const totalCentiseconds = Math.round(Math.max(0, Number(seconds) || 0) * 100);
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = (totalCentiseconds - centiseconds) / 100;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const wholeSeconds = totalSeconds % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return `${hours}:${pad(minutes)}:${pad(wholeSeconds)}.${pad(centiseconds)}`;
}

// Braces open libass override blocks and there is no escape for them, so they cannot be
// allowed through. Newlines become ASS's own break token.
function sanitizeAssText(text) {
  return String(text || "")
    .replace(/[{}]/g, "")
    .replace(/\r?\n/g, "\\N")
    .trim();
}

// The style mirrors the title overlay's treatment (bold, heavy outline, soft shadow) at
// the bottom of the 1080x1920 frame, with the block bottom held ~17% up so platform UI
// does not sit on top of it.
function buildAssSubtitles({ cues, fontFamily }) {
  const family = fontFamily || subtitleFontFamilyForPlatform();
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV",
    `Style: Clip,${family},56,&H00FFFFFF,&H00000000,&H00000000,-1,3,1.5,2,70,70,320`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  for (const cue of cues || []) {
    if (cue.endSeconds <= cue.startSeconds) {
      continue;
    }
    const text = sanitizeAssText(cue.text);
    if (!text) {
      continue;
    }
    lines.push(
      `Dialogue: 0,${formatAssTimestamp(cue.startSeconds)},${formatAssTimestamp(cue.endSeconds)},Clip,,0,0,0,,${text}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function writeClipSubtitles({ cues, workDir, name }) {
  if (!cues || cues.length === 0) {
    return null;
  }

  fs.mkdirSync(workDir, { recursive: true });
  const filePath = path.join(workDir, `${name}.ass`);
  fs.writeFileSync(filePath, buildAssSubtitles({ cues }), "utf8");
  return filePath;
}

module.exports = {
  buildAssSubtitles,
  formatAssTimestamp,
  sliceCuesForClip,
  stripSpeakerPrefix,
  subtitleFontFamilyForPlatform,
  writeClipSubtitles,
};
