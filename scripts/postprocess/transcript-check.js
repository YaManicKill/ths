function escapeRegExp(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
      regex: new RegExp(`\\b${escapeRegExp(word)}\\b`, "gi"),
    }));

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
