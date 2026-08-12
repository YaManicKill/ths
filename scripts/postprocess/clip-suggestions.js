const { formatSecondsToHhmmss } = require("./parsers");

const DEFAULT_OPTIONS = {
  maxSuggestions: 8,
  minClipDurationSeconds: 28,
  maxClipDurationSeconds: 55,
  maxSegmentsPerClip: 7,
  trailingContextSeconds: 12,
};

const HOOK_WORDS = [
  "why",
  "what",
  "how",
  "because",
  "actually",
  "really",
  "crazy",
  "weird",
  "best",
  "worst",
  "surprising",
  "important",
  "no",
  "wait",
  "but",
  "however",
  "maybe",
  "honestly",
  "obviously",
  "frankly",
  "imagine",
  "should",
  "could",
  "would",
  "guess",
  "remember",
  "still",
  "classic",
  "genuinely",
  "literally",
];

const GENERIC_OPENERS =
  /^(yeah|yes|okay|alright|so|well|anyway|anyways|and|but|like|oh|right|i mean|i think|probably|maybe|honestly|actually|really)$/i;
const QUESTION_OPENERS =
  /^(why|what|how|who|when|where|should|could|would|did|do|does|is|are|can|can't|won't|will|have|has|had|was|were)$/i;
const PAYOFF_WORDS =
  /\b(because|so|therefore|turns out|which means|that means|the point is|the lesson is|that's why|the reason is|as a result|in other words)\b/i;
const LOW_SIGNAL_PHRASES =
  /\b(how do you want (?:me )?to say it|i presume you've not seen it|you know what|i don't know)\b/i;

function cleanSummaryText(text) {
  return normalizeWhitespace(String(text || ""))
    .replace(/^(um|uh|so|well|yeah|okay)\s*,?\s*/i, "")
    .replace(/^because\s*,?\s*/i, "Because ")
    .replace(/^you mean\s*,?\s*/i, "")
    .replace(/\s+,/g, ",")
    .trim();
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTimestampToSeconds(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/\(([^)]+)\)/);
  if (!match) {
    return null;
  }

  const raw = match[1].trim();
  let totalSeconds = 0;
  const tokenPattern = /(\d+)([hms])/g;
  tokenPattern.lastIndex = 0;
  let tokenMatch;
  let matched = false;

  while ((tokenMatch = tokenPattern.exec(raw)) !== null) {
    matched = true;
    const amount = Number(tokenMatch[1]);
    const unit = tokenMatch[2];

    if (unit === "h") {
      totalSeconds += amount * 3600;
    } else if (unit === "m") {
      totalSeconds += amount * 60;
    } else {
      totalSeconds += amount;
    }
  }

  return matched ? totalSeconds : null;
}

function toSentenceCase(text) {
  const cleaned = normalizeWhitespace(text).replace(/\s+/g, " ");
  if (!cleaned) {
    return "Clip";
  }

  const firstWord = cleaned.split(" ")[0] || "Clip";
  return `${firstWord[0].toUpperCase()}${firstWord.slice(1)}`;
}

function stripGenericLeadIn(text) {
  const trimmed = normalizeWhitespace(text);
  if (!trimmed) {
    return "";
  }

  const withoutOpeningPunctuation = trimmed.replace(/^[\-–—,:;"'`]+/, "");
  const match = withoutOpeningPunctuation.match(
    /^(?:yeah|yes|okay|alright|so|well|anyway|anyways|and|but|like|oh|right|i mean|i think|probably|maybe|honestly|actually|really)\b(?:\s+|$)/i,
  );
  if (!match) {
    return withoutOpeningPunctuation;
  }

  return normalizeWhitespace(withoutOpeningPunctuation.slice(match[0].length));
}

function deriveClipSummary(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return "";
  }

  const withoutLeadIn = stripGenericLeadIn(normalized);
  const sentences = withoutLeadIn
    .split(/(?<=[.!?])\s+/)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);

  const rankedSentences = sentences
    .map((sentence) => {
      const cleaned = normalizeWhitespace(
        sentence.replace(/^[\-–—,:;"'`]+/, ""),
      );
      const hasQuestionMark = /\?$/.test(cleaned);
      const withoutTrailing = cleaned.replace(/[.!?]+$/, "").trim();
      const isQuestion = hasQuestionMark || withoutTrailing.includes("?");
      const isTooGeneric =
        /^(so|yeah|yes|okay|alright|well|anyway|anyways|and|but|like|oh|right|i mean|i think|probably|maybe|honestly|actually|really)\b/i.test(
          withoutTrailing,
        );
      const words = withoutTrailing.split(/\s+/).filter(Boolean);
      const shortLeadInPenalty =
        /^(i|it|this|that|um)\b/i.test(withoutTrailing) &&
        withoutTrailing.length < 40
          ? -2
          : 0;
      const lowSignalPenalty = LOW_SIGNAL_PHRASES.test(withoutTrailing)
        ? -4
        : 0;
      const densityBonus = words.length >= 6 && words.length <= 18 ? 1 : 0;
      const lengthScore =
        withoutTrailing.length >= 24 && withoutTrailing.length <= 90 ? 3 : 0;
      const hookScore = isQuestion ? 2 : 0;
      const payoffScore = PAYOFF_WORDS.test(withoutTrailing) ? 1 : 0;
      const genericPenalty = isTooGeneric ? -3 : 0;
      return {
        text: withoutTrailing,
        score:
          lengthScore +
          hookScore +
          payoffScore +
          densityBonus +
          genericPenalty +
          shortLeadInPenalty +
          lowSignalPenalty,
      };
    })
    .filter((entry) => entry.text && entry.text.length >= 8);

  const bestSentence = rankedSentences.sort(
    (left, right) => right.score - left.score,
  )[0];
  if (bestSentence && bestSentence.score >= 1) {
    return cleanSummaryText(bestSentence.text);
  }

  const questionMatch = withoutLeadIn.match(/^[^?]+\?/);
  if (questionMatch) {
    return cleanSummaryText(
      normalizeWhitespace(questionMatch[0].replace(/\?$/, "")),
    );
  }

  return cleanSummaryText(
    withoutLeadIn.length > 120
      ? normalizeWhitespace(withoutLeadIn.slice(0, 120))
      : withoutLeadIn,
  );
}

function isGenericStart(text) {
  const cleaned = normalizeWhitespace(text).replace(/^['"(]+|['")]+$/g, "");
  if (!cleaned) {
    return true;
  }

  const firstWord = cleaned.split(/\s+/)[0] || "";
  return GENERIC_OPENERS.test(firstWord) || cleaned.length < 16;
}

function isLowSignalSummary(text) {
  const cleaned = normalizeWhitespace(text);
  if (!cleaned) {
    return true;
  }

  if (LOW_SIGNAL_PHRASES.test(cleaned)) {
    return true;
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 5 && cleaned.length < 28) {
    return true;
  }

  return false;
}

function inferSection(line) {
  const sectionName = normalizeWhitespace(line)
    .replace(/^##\s+/, "")
    .trim();
  if (!sectionName) {
    return "body";
  }

  const normalized = sectionName.toLowerCase();
  if (normalized.includes("intro")) {
    return "intro";
  }
  if (normalized.includes("outro") || normalized.includes("credits")) {
    return "outro";
  }
  return "body";
}

function parseTranscriptSegments(transcriptMdText) {
  if (!transcriptMdText) {
    return [];
  }

  const lines = String(transcriptMdText).split(/\r?\n/);
  const segments = [];
  let currentSection = "body";
  let current = null;

  const pushCurrent = (endSeconds = null) => {
    if (!current) {
      return;
    }

    const text = normalizeWhitespace(current.text);
    if (!text) {
      current = null;
      return;
    }

    const speakerMatch = current.headerText?.match(/\*\*([^:*]+):\*\*/);
    const speaker = speakerMatch ? speakerMatch[1].trim() : null;

    segments.push({
      startSeconds: current.startSeconds,
      endSeconds: endSeconds ?? current.startSeconds,
      text,
      speaker,
      section: current.section,
      source: current.source,
    });

    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    if (line.startsWith("##")) {
      pushCurrent();
      currentSection = inferSection(line);
      continue;
    }

    const timestamp = parseTimestampToSeconds(line);
    if (timestamp !== null) {
      pushCurrent(timestamp);
      current = {
        startSeconds: timestamp,
        endSeconds: timestamp,
        text: "",
        headerText: line,
        section: currentSection,
        source: "timestamp",
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      continue;
    }

    if (line.startsWith("**") && line.includes(":")) {
      continue;
    }

    const cleaned = line.replace(/^>\s?/, "").trim();
    if (!cleaned) {
      continue;
    }

    current.text = `${current.text} ${cleaned}`.trim();
  }

  pushCurrent();

  const filtered = segments.filter(
    (segment) => segment.text && segment.section !== "intro",
  );
  return filtered
    .map((segment) => ({
      ...segment,
      // Anchored to the start: these words carry meaning mid-sentence ("I was so tired").
      text: segment.text
        .replace(/^(?:(?:And|But|So|Yeah|Yes|Okay|Well)\b[\s,]*)+/i, "")
        .trim(),
    }))
    .filter((segment) => segment.text.length >= 12);
}

function scoreSegment(segment) {
  const normalized = segment.text.toLowerCase();
  const words = normalized.match(/[a-z']+/g) || [];
  const wordCount = words.length;

  let score = 0;

  if (segment.text.includes("?")) {
    score += 3;
  }

  if (segment.text.includes("!")) {
    score += 1;
  }

  if (wordCount <= 18) {
    score += 1;
  }

  if (wordCount > 40) {
    score -= 2;
  }

  const hookHits = HOOK_WORDS.filter((word) => normalized.includes(word));
  score += Math.min(hookHits.length, 3);

  const titleCaseMatches = (segment.text.match(/\b[A-Z][a-z]{2,}\b/g) || [])
    .length;
  score += Math.min(titleCaseMatches, 2);

  const firstWord = normalizeWhitespace(segment.text).split(/\s+/)[0] || "";
  if (QUESTION_OPENERS.test(firstWord)) {
    score += 2;
  }

  const genericLeadInPenalty =
    /^(so|yeah|yes|okay|alright|well|anyway|anyways|and|but|like|oh|right|i mean|i think|probably|maybe|honestly|actually|really)\b/i.test(
      segment.text,
    )
      ? -2
      : 0;
  score += genericLeadInPenalty;

  if (segment.section === "outro") {
    score -= 5;
  }

  if (/^thanks|^welcome|^hello|^alright|^okay/i.test(segment.text)) {
    score -= 2;
  }

  return score;
}

function buildClipSuggestions(input = {}) {
  const options = {
    ...DEFAULT_OPTIONS,
    ...input,
  };

  const segments = parseTranscriptSegments(input.transcriptMdText);
  if (segments.length === 0) {
    return [];
  }

  const scoredSegments = segments.map((segment) => ({
    ...segment,
    score: scoreSegment(segment),
  }));

  const candidates = [];

  for (let index = 0; index < scoredSegments.length; index += 1) {
    const first = scoredSegments[index];
    if (first.score <= 0) {
      continue;
    }

    for (let length = 1; length <= options.maxSegmentsPerClip; length += 1) {
      const window = scoredSegments.slice(index, index + length);
      if (window.length === 0) {
        break;
      }

      const startSeconds = window[0].startSeconds;
      const rawEndSeconds = window[window.length - 1].endSeconds;
      const paddedEndSeconds =
        rawEndSeconds +
        Math.max(0, Number(options.trailingContextSeconds || 0));
      const endSeconds = paddedEndSeconds;
      const durationSeconds = Math.max(0, endSeconds - startSeconds);

      if (durationSeconds < options.minClipDurationSeconds) {
        continue;
      }

      if (durationSeconds > options.maxClipDurationSeconds) {
        continue;
      }

      const totalScore = window.reduce(
        (sum, segment) => sum + segment.score,
        0,
      );
      const text = window.map((segment) => segment.text).join(" ");
      const summary = deriveClipSummary(text);
      const isGeneric = isGenericStart(summary) || summary.length < 8;
      const isLowSignal = isLowSignalSummary(summary);
      const firstSegmentText = normalizeWhitespace(window[0].text || "");
      const hasQuestion = window.some((segment) => segment.text.includes("?"));
      const hasPayoff = window.some((segment) =>
        PAYOFF_WORDS.test(segment.text),
      );
      const hookPayoffBonus = hasQuestion && hasPayoff ? 4 : 0;
      const multiBeatBonus =
        window.length >= 3 ? 2 : window.length === 2 ? 1 : 0;
      const contextPenalty =
        isGenericStart(firstSegmentText) && !window[0].text.includes("?")
          ? -3
          : 0;
      const noPayoffPenalty = !hasPayoff && durationSeconds < 30 ? -2 : 0;
      const hookBonus = summary.includes("?") ? 2 : 0;
      const payoffBonus = PAYOFF_WORDS.test(summary) ? 1 : 0;
      const durationBonus =
        durationSeconds >= 30 ? 2 : durationSeconds >= 25 ? 1 : 0;
      const genericPenalty = isGeneric ? -3 : 0;
      const lowSignalPenalty = isLowSignal ? -4 : 0;
      const score =
        totalScore +
        multiBeatBonus +
        hookPayoffBonus +
        hookBonus +
        payoffBonus +
        durationBonus +
        genericPenalty +
        lowSignalPenalty +
        contextPenalty +
        noPayoffPenalty;

      if (score < 7 || !summary || summary.length > 180 || isLowSignal) {
        continue;
      }

      candidates.push({
        startSeconds,
        endSeconds,
        durationSeconds,
        score,
        text,
        summary,
        speaker: window[0].speaker || null,
        reason:
          score >= 8
            ? "strong hook and clear payoff"
            : "good conversational beat",
        title: toSentenceCase(summary),
        timestampLabel: `${formatSecondsToHhmmss(startSeconds)}-${formatSecondsToHhmmss(endSeconds)}`,
      });
    }
  }

  const accepted = [];

  candidates
    .sort((left, right) => right.score - left.score)
    .forEach((candidate) => {
      // Compare the whole span, not just start times: two clips 20s apart can still
      // share most of their audio when each one runs for up to a minute.
      const overlaps = accepted.some(
        (existing) =>
          candidate.startSeconds < existing.endSeconds &&
          existing.startSeconds < candidate.endSeconds,
      );

      if (overlaps) {
        return;
      }

      accepted.push(candidate);
    });

  return accepted.slice(0, options.maxSuggestions);
}

module.exports = {
  buildClipSuggestions,
  parseTranscriptSegments,
  scoreSegment,
};
