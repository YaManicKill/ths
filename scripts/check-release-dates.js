#!/usr/bin/env node
'use strict';

// Checks the "Release Date" text on every game in the Notion games database
// against IGDB and reports contradictions, windows that can be tightened,
// EA games whose 1.0 has been announced, and possibly-abandoned games.
// Games IGDB doesn't know (or has no date for) fall back to a Steam store
// lookup — smaller games are often on Steam before IGDB curates them.
//
// Credentials live in scripts/.env (see scripts/.env keys):
//   NOTION_TOKEN, NOTION_DATABASE_ID, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET
//
// Usage: node scripts/check-release-dates.js [--all] [--limit=N]
//   --all      also print games that checked out OK
//   --limit=N  only check the first N games (for testing)

const fs = require('fs');
const path = require('path');

const NOTION_VERSION = '2022-06-28';
const IGDB_DELAY_MS = 300; // IGDB caps at 4 requests/second

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const IGDB_PC_PLATFORM = 6;

const STATUS_NAMES = {
  0: 'Released', 2: 'Alpha', 3: 'Beta', 4: 'Early Access',
  5: 'Offline', 6: 'Cancelled', 7: 'Rumored', 8: 'Delisted',
};

const RANK = { day: 4, month: 3, quarter: 2, year: 1 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    console.error(`Missing in scripts/.env: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// --- Notion ---

async function notionFetchAllPages(token, databaseId) {
  const pages = [];
  let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 404) {
        throw new Error(
          `Notion returned 404 — check NOTION_DATABASE_ID, and make sure the database is shared with your integration (⋯ → Connections). Body: ${body}`
        );
      }
      throw new Error(`Notion query failed (${res.status}): ${body}`);
    }
    const data = await res.json();
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

function extractGame(page) {
  const props = page.properties;
  let title = '';
  for (const p of Object.values(props)) {
    if (p.type === 'title') title = p.title.map((t) => t.plain_text).join('').trim();
  }
  const rd = props['Release Date'];
  const releaseText = rd && rd.rich_text
    ? rd.rich_text.map((t) => t.plain_text).join('').trim()
    : '';
  const checkbox = (name) => Boolean(props[name] && props[name].checkbox);
  const eaDate = props['EA Date'] && props['EA Date'].date ? props['EA Date'].date.start : null;
  return {
    title,
    releaseText,
    eaDate,
    abandoned: checkbox('Abandoned?'),
    released: checkbox('Released?'),
    url: page.url,
  };
}

// --- Parsing the Notion "Release Date" text ---

const ym = (y, m) => y * 12 + (m - 1);

const SEASONS = {
  spring: [3, 5], summer: [6, 8], fall: [9, 11], autumn: [9, 11],
  early: [1, 4], mid: [5, 8], late: [9, 12],
  h1: [1, 6], h2: [7, 12],
  q1: [1, 3], q2: [4, 6], q3: [7, 9], q4: [10, 12],
};

function parseNotionDate(raw) {
  const text = raw.trim();
  if (!text) return { kind: 'empty', label: '(empty)' };
  if (/^abandoned\??$/i.test(text)) return { kind: 'abandoned', label: text };
  if (/^(tba|tbd)$/i.test(text)) return { kind: 'tba', label: text };
  if (/^1\.0\s*(tba|tbd)$/i.test(text)) return { kind: 'ea-tba', label: text };

  const t = text.replace(/\?+$/, '').trim();
  let m;

  if ((m = t.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i))) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month) {
      const y = Number(m[3]);
      return {
        kind: 'date', precision: 'day', label: text,
        y, m: month, d: Number(m[2]), start: ym(y, month), end: ym(y, month),
      };
    }
  }
  if ((m = t.match(/^([a-z]{3,9})\.?,?\s+(\d{4})$/i))) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month) {
      const y = Number(m[2]);
      return { kind: 'date', precision: 'month', label: text, y, m: month, start: ym(y, month), end: ym(y, month) };
    }
  }
  if ((m = t.match(/^(spring|summer|fall|autumn|early|mid|late|h1|h2|q1|q2|q3|q4)\s+(\d{4})$/i))) {
    const [a, b] = SEASONS[m[1].toLowerCase()];
    const y = Number(m[2]);
    return { kind: 'date', precision: 'quarter', label: text, y, start: ym(y, a), end: ym(y, b) };
  }
  if ((m = t.match(/^winter\s+(\d{4})$/i))) {
    const y = Number(m[1]);
    return { kind: 'date', precision: 'quarter', label: text, y, start: ym(y, 12), end: ym(y + 1, 2) };
  }
  if ((m = t.match(/^(\d{4})$/))) {
    const y = Number(m[1]);
    return { kind: 'date', precision: 'year', label: text, y, start: ym(y, 1), end: ym(y, 12) };
  }
  return { kind: 'unknown', label: text };
}

// --- IGDB ---

async function igdbAuth(clientId, clientSecret, staticToken) {
  if (clientSecret) {
    const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`;
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) throw new Error(`Twitch auth failed (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return { clientId, token: data.access_token };
  }
  return { clientId, token: staticToken };
}

// game_status replaced status in IGDB's API; fall back for older schemas.
const IGDB_FIELD_SETS = [
  'name, first_release_date, game_status, release_dates.date, release_dates.human, release_dates.m, release_dates.y, release_dates.platform, release_dates.status.name',
  'name, first_release_date, status, release_dates.date, release_dates.human, release_dates.m, release_dates.y, release_dates.platform, release_dates.status.name',
  'name, first_release_date, release_dates.date, release_dates.human, release_dates.m, release_dates.y, release_dates.platform',
];
let igdbFieldSet = 0;

async function igdbRequest(auth, buildBody) {
  while (true) {
    const res = await fetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: { 'Client-ID': auth.clientId, Authorization: `Bearer ${auth.token}` },
      body: buildBody(IGDB_FIELD_SETS[igdbFieldSet]),
    });
    if (res.status === 400 && igdbFieldSet < IGDB_FIELD_SETS.length - 1) {
      igdbFieldSet += 1;
      continue;
    }
    if (res.status === 429) {
      await sleep(1500);
      continue;
    }
    if (res.status === 401) {
      throw new Error(
        'IGDB auth rejected (401). IGDB access tokens expire after ~60 days — set TWITCH_CLIENT_SECRET in scripts/.env so the script can mint fresh tokens itself.'
      );
    }
    if (!res.ok) throw new Error(`IGDB query failed (${res.status}): ${await res.text()}`);
    return res.json();
  }
}

const normalize = (s) =>
  s.normalize('NFKD').toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

const slugify = (s) => normalize(s).replace(/ /g, '-');

function pickCandidate(results, name) {
  if (!results.length) return null;
  const target = normalize(name);
  return results.find((r) => normalize(r.name) === target) || results[0];
}

async function igdbLookup(auth, name) {
  const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const results = await igdbRequest(
    auth,
    (f) => `search "${escaped}"; fields ${f}; where version_parent = null; limit 10;`
  );
  const candidate = pickCandidate(results, name);
  if (candidate && normalize(candidate.name) === normalize(name)) {
    candidate.exactMatch = true;
    return candidate;
  }
  // IGDB search misses stopword-heavy titles ("Out and About") and doesn't
  // bridge UK/US spellings, so fall back to direct slug lookups.
  const slugs = [...new Set([slugify(name), slugify(name).replace(/our/g, 'or')])];
  const bySlug = await igdbRequest(
    auth,
    (f) => `fields ${f}; where slug = (${slugs.map((s) => `"${s}"`).join(',')}); limit 5;`
  );
  if (bySlug.length) {
    bySlug[0].exactMatch = true;
    return bySlug[0];
  }
  return candidate;
}

function gameStatusId(game) {
  const raw = game.game_status != null ? game.game_status : game.status;
  if (raw == null) return null;
  return typeof raw === 'object' ? raw.id : raw;
}

function entryToWindow(entry) {
  const human = entry.human || '';
  if (/^tbd$/i.test(human)) return null;
  let precision = null;
  if (/^[A-Za-z]{3} \d{2}, \d{4}$/.test(human)) precision = 'day';
  else if (/^[A-Za-z]{3} \d{4}$/.test(human)) precision = 'month';
  else if (/^Q[1-4] \d{4}$/.test(human)) precision = 'quarter';
  else if (/^\d{4}$/.test(human)) precision = 'year';
  else if (entry.m && entry.y) precision = 'month';
  else if (entry.y) precision = 'year';
  else if (entry.date) precision = 'day';
  if (!precision) return null;

  if (precision === 'day') {
    if (!entry.date) return null;
    const d = new Date(entry.date * 1000);
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    return {
      precision, y, m: mo, d: d.getUTCDate(),
      start: ym(y, mo), end: ym(y, mo),
      human: human || d.toISOString().slice(0, 10),
      unix: entry.date,
    };
  }
  if (precision === 'month') {
    let y = entry.y;
    let mo = entry.m;
    if (!y || !mo) {
      const hm = human.match(/^([A-Za-z]{3}) (\d{4})$/);
      if (hm) { mo = MONTHS[hm[1].toLowerCase()]; y = Number(hm[2]); }
    }
    if (!y || !mo) return null;
    return { precision, y, m: mo, start: ym(y, mo), end: ym(y, mo), human: human || `${mo}/${y}` };
  }
  if (precision === 'quarter') {
    const qm = human.match(/^Q([1-4]) (\d{4})$/);
    if (!qm) return null;
    const q = Number(qm[1]);
    const y = Number(qm[2]);
    return { precision, y, start: ym(y, q * 3 - 2), end: ym(y, q * 3), human };
  }
  const y = entry.y || Number(human);
  if (!y) return null;
  return { precision: 'year', y, start: ym(y, 1), end: ym(y, 12), human: human || String(y) };
}

function bestIgdbWindow(game, eaDate) {
  let entries = game.release_dates || [];
  // Dates go by PC (Steam) — a Switch port or mobile launch is never the date
  // the Notion entry means. Only a game with no PC presence at all (a
  // platform exclusive) is judged by its other platforms. Decided on the raw
  // entries so a PC game whose dates all get filtered below stays PC-scoped.
  const pcEntries = entries.filter((e) => e.platform === IGDB_PC_PLATFORM);
  if (pcEntries.length) entries = pcEntries;
  // Alpha/beta entries are never the tracked date. Early Access entries are
  // the tracked date only until the game launches into EA (EA Date set) —
  // after that the Notion date refers to 1.0.
  entries = entries.filter((e) => {
    const statusName = e.status && typeof e.status === 'object' ? e.status.name : null;
    if (!statusName) return true;
    if (/^(alpha|beta)$/i.test(statusName)) return false;
    if (/^early access$/i.test(statusName)) return !eaDate;
    return true;
  });
  let windows = entries.map(entryToWindow).filter(Boolean);
  if (!windows.length && !(game.release_dates || []).length && game.first_release_date) {
    windows = [entryToWindow({ date: game.first_release_date, human: '' })].filter(Boolean);
  }
  // For EA games, dates up to the EA launch are the EA release, not 1.0.
  if (eaDate) {
    const cutoff = ym(Number(eaDate.slice(0, 4)), Number(eaDate.slice(5, 7)));
    windows = windows.filter((w) =>
      w.precision === 'day' ? new Date(w.unix * 1000).toISOString().slice(0, 10) > eaDate : w.end > cutoff
    );
  }
  if (!windows.length) return null;
  windows.sort((a, b) => a.start - b.start || RANK[b.precision] - RANK[a.precision]);
  return windows[0];
}

// --- Steam fallback ---

function parsedToWindow(parsed, label) {
  if (!parsed || parsed.kind !== 'date') return null;
  return {
    precision: parsed.precision, y: parsed.y, m: parsed.m, d: parsed.d,
    start: parsed.start, end: parsed.end, human: label,
  };
}

function parseSteamDate(text) {
  if (!text) return null;
  let t = text.trim();
  const dayFirst = t.match(/^(\d{1,2}) ([A-Za-z]{3,9}),? (\d{4})$/);
  if (dayFirst) t = `${dayFirst[2]} ${dayFirst[1]}, ${dayFirst[3]}`;
  return parsedToWindow(parseNotionDate(t), text.trim());
}

async function steamSearchItems(term) {
  const res = await fetch(
    `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`
  );
  if (!res.ok) return [];
  return (await res.json()).items || [];
}

// Exact name matches only — a fallback source picking "close" titles reports
// the wrong game with full confidence.
async function steamLookup(title) {
  const target = normalize(title);
  let item = (await steamSearchItems(title)).find((i) => normalize(i.name) === target);
  if (!item) {
    // Steam's search chokes on subtitled titles ("Kloa - Child of the Forest")
    // that a search for just the lead segment finds.
    const lead = title.split(/\s+[-–:]\s+|:\s+/)[0];
    if (lead && lead !== title) {
      item = (await steamSearchItems(lead)).find((i) => normalize(i.name) === target);
    }
  }
  if (!item) return null;
  const appRes = await fetch(`https://store.steampowered.com/api/appdetails?appids=${item.id}`);
  if (!appRes.ok) return null;
  const appData = (await appRes.json())[item.id];
  if (!appData || !appData.success || !appData.data) return null;
  const releaseDate = appData.data.release_date || {};
  return {
    name: appData.data.name || item.name,
    window: parseSteamDate(releaseDate.date),
    comingSoon: Boolean(releaseDate.coming_soon),
  };
}

function judgeSteam(game, parsed, steam) {
  if (!steam) return null;
  if (!steam.window) {
    // "Coming soon" / "To be announced" — confirms a TBA entry, says nothing
    // about a concrete date.
    return parsed.kind === 'tba'
      ? { verdict: 'OK', detail: 'Steam lists it as TBA too' }
      : null;
  }
  let result;
  if (parsed.kind === 'tba') {
    result = { verdict: 'UPGRADE', detail: `Steam now lists ${steam.window.human}` };
  } else {
    result = compareWindows(parsed, steam.window, 'Steam');
    if (result.verdict === 'OK') result.detail = 'agrees with Steam (IGDB lacks data)';
  }
  return result;
}

// --- Comparison ---

function compareWindows(n, g, source = 'IGDB') {
  if (n.precision === 'day' && g.precision === 'day') {
    return n.y === g.y && n.m === g.m && n.d === g.d
      ? { verdict: 'OK' }
      : { verdict: 'MISMATCH', detail: `${source} says ${g.human}` };
  }
  const nInG = n.start >= g.start && n.end <= g.end;
  const gInN = g.start >= n.start && g.end <= n.end;
  const overlap = n.start <= g.end && g.start <= n.end;
  if (gInN && RANK[g.precision] > RANK[n.precision]) {
    return { verdict: 'UPGRADE', detail: `${source} now lists ${g.human}` };
  }
  if (gInN || nInG) return { verdict: 'OK' };
  if (overlap) return { verdict: 'CHECK', detail: `your window and ${source}'s (${g.human}) only partially overlap` };
  return { verdict: 'MISMATCH', detail: `${source} says ${g.human}` };
}

function judge(game, parsed, candidate) {
  if (!candidate) {
    // A suspected-abandoned game unknown to IGDB has nothing to report.
    if (parsed.kind === 'abandoned') return { verdict: 'OK' };
    return { verdict: 'NOTFOUND', detail: 'no IGDB search results' };
  }

  const statusId = gameStatusId(candidate);
  const statusName = statusId != null ? STATUS_NAMES[statusId] || `status ${statusId}` : null;
  const best = bestIgdbWindow(candidate, game.eaDate);
  const fuzzy = !candidate.exactMatch && normalize(candidate.name) !== normalize(game.title);

  let result;
  if (parsed.kind === 'abandoned') {
    result = best
      ? { verdict: 'CHECK', detail: `IGDB lists a date: ${best.human} (status: ${statusName || 'unknown'}) — maybe not abandoned` }
      : { verdict: 'OK' };
  } else if (statusId === 6 && !game.abandoned) {
    result = { verdict: 'CHECK', detail: 'IGDB lists this game as Cancelled' };
  } else if (parsed.kind === 'tba') {
    result = best
      ? { verdict: 'UPGRADE', detail: `IGDB now lists ${best.human}` }
      : { verdict: 'OK' };
  } else if (parsed.kind === 'ea-tba') {
    if (best) result = { verdict: 'UPGRADE', detail: `IGDB lists ${best.human} — possible 1.0 date` };
    else if (statusId === 0 && game.eaDate) {
      result = { verdict: 'CHECK', detail: 'IGDB status is Released — 1.0 may already be out' };
    } else result = { verdict: 'OK' };
  } else if (parsed.kind === 'empty' || parsed.kind === 'unknown') {
    result = {
      verdict: 'UNPARSED',
      detail: `couldn't parse your value${best ? `; IGDB lists ${best.human}` : ''}`,
    };
  } else if (!best) {
    result = {
      verdict: 'UNVERIFIABLE',
      detail: game.eaDate ? 'IGDB lists no date beyond the EA launch' : 'IGDB has no date listed',
    };
  } else {
    result = compareWindows(parsed, best);
  }

  // Inexact matches may be a different game entirely — quarantine them so a
  // wrong match never lands in the trusted sections.
  if (fuzzy && result.verdict !== 'OK') {
    result.detail = [`IGDB matched "${candidate.name}"`, `${result.verdict.toLowerCase()}${result.detail ? `: ${result.detail}` : ''}`].join(' — ');
    result.verdict = 'FUZZY';
  } else if (fuzzy) {
    result = { verdict: 'FUZZY', detail: `IGDB matched "${candidate.name}" — dates agree, but verify it's the right game` };
  }
  return result;
}

// --- Main ---

const SECTIONS = [
  ['MISMATCH', '❌ Mismatches'],
  ['CHECK', '👀 Check manually'],
  ['UPGRADE', '📅 Can be made more specific'],
  ['FUZZY', '🤔 Inexact IGDB match — verify these'],
  ['NOTFOUND', '❓ Not found on IGDB'],
  ['UNPARSED', '⚠️  Unparseable Release Date text'],
  ['UNVERIFIABLE', '·  Unverifiable (IGDB lacks data)'],
];

async function main() {
  loadEnv();
  requireEnv(['NOTION_TOKEN', 'NOTION_DATABASE_ID']);
  const clientId = process.env.TWITCH_CLIENT_ID || process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET || process.env.IGDB_CLIENT_SECRET;
  const staticToken = process.env.IGDB_ACCESS_TOKEN;
  if (!clientId || (!clientSecret && !staticToken)) {
    console.error(
      'IGDB credentials missing in scripts/.env: need TWITCH_CLIENT_ID (or IGDB_CLIENT_ID) plus either TWITCH_CLIENT_SECRET or IGDB_ACCESS_TOKEN.'
    );
    process.exit(1);
  }

  const showAll = process.argv.includes('--all');
  const limitArg = process.argv.find((a) => a.startsWith('--limit'));
  const limit = limitArg ? Number(limitArg.split('=')[1] || process.argv[process.argv.indexOf(limitArg) + 1]) : Infinity;

  console.error('Fetching games from Notion…');
  const pages = await notionFetchAllPages(process.env.NOTION_TOKEN, process.env.NOTION_DATABASE_ID);
  const games = pages.map(extractGame).filter((g) => g.title);
  const skippedAbandoned = games.filter((g) => g.abandoned).length;
  const skippedReleased = games.filter((g) => !g.abandoned && g.released).length;
  const toCheck = games.filter((g) => !g.abandoned && !g.released).slice(0, limit);
  console.error(`${games.length} games, checking ${toCheck.length} (skipped ${skippedReleased} released, ${skippedAbandoned} abandoned).`);

  const auth = await igdbAuth(clientId, clientSecret, staticToken);

  const results = [];
  for (let i = 0; i < toCheck.length; i++) {
    const game = toCheck[i];
    if (process.stderr.isTTY) {
      process.stderr.write(`\rChecking ${String(i + 1).padStart(3)}/${toCheck.length}  ${game.title.slice(0, 50).padEnd(50)}`);
    }
    const parsed = parseNotionDate(game.releaseText);
    let verdict;
    try {
      verdict = judge(game, parsed, await igdbLookup(auth, game.title));
    } catch (err) {
      if (/401|auth/i.test(err.message)) throw err;
      verdict = { verdict: 'CHECK', detail: `lookup failed: ${err.message}` };
    }
    // Steam can't distinguish an EA launch from 1.0, so it only backs up IGDB
    // for games that haven't launched into EA.
    if (
      (verdict.verdict === 'NOTFOUND' || verdict.verdict === 'UNVERIFIABLE') &&
      !game.eaDate &&
      (parsed.kind === 'tba' || parsed.kind === 'date')
    ) {
      const steamVerdict = judgeSteam(game, parsed, await steamLookup(game.title).catch(() => null));
      if (steamVerdict) verdict = steamVerdict;
    }
    results.push({ game, parsed, ...verdict });
    await sleep(IGDB_DELAY_MS);
  }
  if (process.stderr.isTTY) process.stderr.write(`\r${' '.repeat(70)}\r`);

  for (const [key, heading] of SECTIONS) {
    const rows = results.filter((r) => r.verdict === key);
    if (!rows.length) continue;
    console.log(`\n${heading} (${rows.length})`);
    for (const r of rows) {
      console.log(`  - ${r.game.title}: you have "${r.game.releaseText || '(empty)'}"${r.detail ? ` — ${r.detail}` : ''}`);
    }
  }

  const ok = results.filter((r) => r.verdict === 'OK');
  if (showAll && ok.length) {
    console.log(`\n✅ OK (${ok.length})`);
    for (const r of ok) console.log(`  - ${r.game.title}: "${r.game.releaseText}"`);
  }

  const counts = SECTIONS.map(([key]) => [key, results.filter((r) => r.verdict === key).length])
    .filter(([, n]) => n)
    .map(([key, n]) => `${key.toLowerCase()}: ${n}`)
    .join(', ');
  console.log(`\nChecked ${results.length} games — ok: ${ok.length}${counts ? `, ${counts}` : ''} (skipped ${skippedReleased} released, ${skippedAbandoned} abandoned).`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
