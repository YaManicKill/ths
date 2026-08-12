function escapeRegExp(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMatcherRegex(term) {
  const normalized = String(term || "")
    .trim()
    .toLowerCase();

  if (!normalized) {
    return null;
  }

  const wildcard = normalized.endsWith("*");
  const stem = wildcard ? normalized.slice(0, -1) : normalized;
  if (!stem) {
    return null;
  }

  const escapedStem = escapeRegExp(stem);
  // Asterisk suffix means "match word-family variants", e.g. "shit*" => "shit", "shits", "shitty".
  const tokenPattern = wildcard ? `${escapedStem}[a-z0-9']*` : escapedStem;
  return new RegExp(`\\b${tokenPattern}\\b`, "gi");
}

function findWordMatches(text, words) {
  const lines = String(text || "").split(/\r?\n/);
  const compiled = words
    .map((word) =>
      String(word || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean)
    .map((word) => ({
      word,
      regex: buildMatcherRegex(word),
    }))
    .filter((item) => item.regex);

  const matches = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    for (const item of compiled) {
      item.regex.lastIndex = 0;
      let match;
      while ((match = item.regex.exec(line)) !== null) {
        matches.push({
          word: item.word,
          line: lineIndex + 1,
          column: match.index + 1,
          text: line.trim(),
        });
      }
    }
  }

  return matches;
}

module.exports = {
  findWordMatches,
};
