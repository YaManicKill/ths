# Episode Post-Processing

## Prerequisites

- Node 24+ (declared in `engines`, and enforced by `.npmrc`)
- `ffmpeg` and `ffprobe` on PATH, built with `libfreetype` and `libass`. Homebrew core
  ships without them; use `brew install homebrew-ffmpeg/ffmpeg/ffmpeg` instead.
- `python3` on PATH with `mutagen` installed (`python3 -m pip install --user mutagen`),
  used to embed per-chapter images into the MP3.

## Running It

```bash
npm run postprocess
```

It finds the next episode's assets under the configured Episodes folder, starts the web
UI on `http://localhost:4173`, and opens the browser prefilled with discovery already
running. Discovery only writes scratch files under `.cache/postprocess/`; nothing else
is touched until you press **Approve**.

| Flag                           | Effect                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--new-season`                 | Force the next season, episode 01, instead of incrementing the episode number.                                                                                |
| `--episode-number <EE\|SS-EE>` | Target a specific episode and infer its publish date from that position in the sequence. `5` keeps the inferred season; `12-05` sets both season and episode. |

Pressing Approve creates the `ep-SS-EE` branch, generates `index.md` and the transcripts
(with AI fixes applied — see below), embeds chapter images into the MP3 (keeping a
`.bak`), and renders the full-episode MP4. Clip videos are generated separately from the
suggestion cards; they use the show logo rather than chapter images, and carry the
episode title, burned-in subtitles and a progress bar.

## The UI

- **AI transcript check** (needs an LLM key): flags likely mistranscriptions, including
  wrong spellings of the configured `hostNames`. High-confidence fixes are applied to
  the generated transcripts automatically — the source transcripts are never modified —
  and medium-confidence ones get checkboxes plus an **Apply Ticked Fixes** button.
  **Re-run Transcript Check** re-reviews the written transcripts after hand edits.
- **AI clip suggestions**: up to 10 moments picked from the whole transcript, each with
  a hook title, reason, and a paste-ready caption (the show hashtags are always
  included). Heuristic suggestions are the fallback without a key. Rendering clips also
  writes a `captions.txt` next to them.
- **Clip cards** have audio preview, approve/deny, a waveform trim for the clip's
  start/end, and an inline transcript editor whose edits land in both episode
  transcripts. Generation queues behind an active MP4 render and can be cancelled.
- **Shownotes links**: editable, reorderable rows that become index.md's `## Links`
  section — seeded from the auto-resolved Steam links plus the chapter before Outro
  (the main topic; delete the row when it isn't a game). Pasting a URL fetches the
  page title as an editable default.
- **Audio QC**: warning-only loudness / true peak / long-silence check on the MP3
  during discovery, cached until the file changes.
- **YouTube Description** converts the episode's current index.md (chapters in
  YouTube's timestamp format, links included) into `youtube-description.txt` next to
  the MP4, and copies it to the clipboard. Run it after any final shownotes edits.
- Suggestions, links and unapplied fixes are stored in the episode's
  `postprocess-report.json` and restored after a refresh or restart; **Clear & Restart
  Process** wipes that state for a fresh start.
- LLM results are cached by content and all AI checks are warning-only — failures never
  block a run. A full episode costs ~4 requests; free-tier quotas are per model, so
  switching `llm.model` gets a fresh daily bucket.

## Episode Number Inference

Without `--episode-number`, the next episode code is inferred from the episodes already
on the site:

- max 26 episodes per season
- the first episode published after 30 June or 31 December (in the configured timezone)
  starts a new season, even if the break skipped clean over July or January
- exception: a season standing at 25 episodes takes its 26th on the first Wednesday of
  July (some years only have 25 first-half Wednesdays); nothing spills across a year end
- otherwise increment the episode number

## Configuration

Main config is `postprocess.config.json` at the repo root; every key is optional, with
defaults in `config.js`.

| Key                | Default                       | What it does                                                                                                     |
| ------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `episodesRoot`     | `~/Google Drive/.../Episodes` | Where source assets are searched for (MP3, transcripts). `~` is expanded. Searched up to 4 directories deep.     |
| `outputRoot`       | `content/episode`             | Where generated episode folders are written, relative to the repo root. Also where episode inference reads from. |
| `defaultAuthor`    | `Al McKinlay`                 | The `author` field in generated `index.md` frontmatter.                                                          |
| `releaseTimeLocal` | `19:00:00`                    | Local time of day used for inferred publish dates.                                                               |
| `timezone`         | `Europe/London`               | IANA zone the release time is interpreted in. The UTC offset is computed per date, so DST is handled.            |
| `profanityWords`   | built-in list                 | Word list for the warning-only transcript check; setting it replaces the defaults. Wildcards like `shit*` work.  |
| `hostNames`        | the five regulars             | Correct spellings of the recurring hosts. The AI transcript check flags any other spelling of them as a mistake. |
| `llm.provider`     | `gemini`                      | Which LLM backs the AI features. Only `gemini` is implemented so far.                                            |
| `llm.model`        | `gemini-3.6-flash`            | The model used for the AI features.                                                                              |
| `llm.apiKey`       | unset                         | API key for the LLM provider. **Never put this in the main config** — see below.                                 |

Secrets go in `postprocess.config.local.json` (gitignored — the main config is committed
to a public repo). It is deep-merged over the main config:

```json
{ "llm": { "apiKey": "your-gemini-key" } }
```

`GEMINI_API_KEY` in the environment works as a fallback; with no key set, the AI
features simply don't run. Verify a fresh key with `node scripts/postprocess/llm.js`.

Persistent per-chapter image overrides live in `data/chapter-image-overrides.json`, with
the images in `.cache/postprocess/manual-images/`. Everything else under
`.cache/postprocess/` is scratch, pruned automatically; deleting it by hand is safe
apart from `manual-images/`.

## Tests

```bash
npm run test:postprocess
```

Plain `node --test` files alongside the code they cover. They need `ffmpeg` on PATH and
work entirely in temp directories.

## Desktop App

An Electron wrapper lives in `app/`, isolated in its own package so the main repo (and
CI) never installs Chromium. One-time setup:

```bash
cd scripts/postprocess/app
npm install
npm run dist
```

That produces `dist/mac-arm64/THS Post-Process.app` with the show icon and this repo's
location baked in — pin it to the dock. Clicking it runs the pipeline server in-process
and opens the prefilled UI in its own window; closing the window quits everything. The
app loads the pipeline code from the repo checkout at launch, so day-to-day changes need
no rebuild.
