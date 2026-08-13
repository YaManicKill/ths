# The Harvest Season

Code for the THS site

## Dev

- `npm install` to install dependencies
- Edit `content/episode/` files
- Upload mp3 file
- Run `npm run dev`
- Access `localhost:1313`

## Deploy

Deploy is done with `npm run build` but it is handled by circleci in the `.circleci/config.yml` file, automatically built and pushed to production server.

## Episode Post-Processing

Lives in `scripts/postprocess/`.

### Prerequisites

- Node 24+ (declared in `engines`, and enforced by `.npmrc`)
- `ffmpeg` and `ffprobe` available in PATH, built with `libfreetype` and `libass` (the
  `drawtext` and `subtitles` filters). Homebrew core ships without them; use
  `brew install homebrew-ffmpeg/ffmpeg/ffmpeg` instead. Clip generation checks for
  `drawtext` up front and refuses to render unlabelled clips silently.
- `python3` available in PATH, with the `mutagen` package installed:
  `python3 -m pip install --user mutagen`

Python is used to embed per-chapter images into the MP3. Both it and `mutagen` are
checked during discovery (as a warning) and again before a run writes anything, so a
missing dependency fails before any branch or file is created.

### Running It

```bash
npm run postprocess
```

That is the whole interface. It finds the next episode's assets under the configured
Episodes folder, starts the local web UI on `http://localhost:4173`, opens your browser
with every field prefilled, and automatically runs discovery.

Discovery parses chapters, resolves images, checks transcripts and builds clip
suggestions. It never touches your MP3, your episode assets or the site content — its only
writes are scratch files under `.cache/postprocess/`. Nothing else is written until you
press **Approve** in the UI.

Optional flags:

| Flag                           | Effect                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--new-season`                 | Force the next season, episode 01, instead of incrementing the episode number.                                                                                |
| `--episode-number <EE\|SS-EE>` | Target a specific episode and infer its publish date from that position in the sequence. `5` keeps the inferred season; `12-05` sets both season and episode. |

### What A Run Does

Pressing Approve in the UI:

- Validates the MP3 filename (`ths-SS-EE.mp3`) and the required tools
- Reads chapter timings from the MP3's own metadata
- Resolves chapter images from your saved overrides, falling back to the MP3 cover art
- Creates and checks out an `ep-SS-EE` git branch
- Generates `index.md`, `transcript.md` and `transcript.vtt` in the episode folder
- Runs the AI transcript check and applies its high-confidence fixes to the generated
  transcripts (see below; the source transcripts are never modified)
- Embeds per-chapter images into MP3 chapter metadata (via `embed_chapter_images.py`,
  keeping a `.bak` of the original alongside it)
- Generates a 1080x1080 MP4 chapter-image video
- Runs warning-only inappropriate word checks on the transcripts

Per-chapter images are used for the MP3 chapter metadata and the full-episode MP4. Clip
videos deliberately do not use them: they use the show logo from the project `Assets`
folder, falling back to the MP3 cover art.

### Episode Number Inference

If you don't pass `--episode-number`, the next episode code is inferred from the episodes
already on the site, using these rules:

- max 26 episodes per season
- the first episode published in January or July starts a new season
- otherwise increment the episode number

### Configuration

Main config is `postprocess.config.json` at the repo root. Every key is optional; the
defaults in `DEFAULT_CONFIG` in `config.js` are used when a key is absent. `config.js` is
the only reader, shared by the CLI, the pipeline and the web server, and it validates
`timezone` and `releaseTimeLocal` on load rather than failing later.

| Key                | Default                       | What it does                                                                                                     |
| ------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `episodesRoot`     | `~/Google Drive/.../Episodes` | Where source assets are searched for (MP3, transcripts). `~` is expanded. Searched up to 4 directories deep.     |
| `outputRoot`       | `content/episode`             | Where generated episode folders are written, relative to the repo root. Also where episode inference reads from. |
| `defaultAuthor`    | `Al McKinlay`                 | The `author` field in generated `index.md` frontmatter.                                                          |
| `releaseTimeLocal` | `19:00:00`                    | Local time of day used for inferred publish dates.                                                               |
| `timezone`         | `Europe/London`               | IANA zone the release time is interpreted in. The UTC offset is computed per date, so DST is handled.            |
| `profanityWords`   | see below                     | Extra words for the warning-only transcript check. Wildcards like `shit*` match word families.                   |
| `hostNames`        | the five regulars             | Correct spellings of the recurring hosts. The AI transcript check flags any other spelling of them as a mistake. |
| `llm.provider`     | `gemini`                      | Which LLM backs the AI transcript check. Only `gemini` is implemented so far.                                    |
| `llm.model`        | `gemini-3.6-flash`            | The model used for the AI transcript check.                                                                      |
| `llm.apiKey`       | unset                         | API key for the LLM provider. **Never put this in the main config** — see below.                                 |

`profanityWords` from config is unioned with a hardcoded default list, so it can only add
words, never remove them.

Secrets go in `postprocess.config.local.json` (gitignored — the main config is committed
to a public repo). It is deep-merged over the main config, so it only needs the keys you
are overriding:

```json
{ "llm": { "apiKey": "your-gemini-key" } }
```

`GEMINI_API_KEY` in the environment works as a fallback. With no key set, the AI
transcript check simply doesn't run. Verify a fresh key with
`node scripts/postprocess/llm.js`.

### AI Transcript Check

When an LLM key is configured, pressing Approve sends the transcript (chunked by
chapter, so each request carries the chapter title as topic context) to the configured
model and flags likely mistranscriptions — words the surrounding context shows are
wrong, like "grow weight" for "grow wings". The configured `hostNames` are given to the
model as the only correct spellings, so "Cody" or "Jonny" get flagged as
mistranscriptions of "Codey" and "Jonnie". High-confidence findings are applied to the
generated `transcript.md` and `transcript.vtt` automatically; the source transcripts in
the Episodes folder are never modified. Medium-confidence findings appear in the UI with
checkboxes — tick the ones that look right and press **Apply Ticked Fixes** to update
the generated transcripts in place. Clip subtitles are rendered from the episode's
written `transcript.vtt`, so they carry the same fixes.

**Re-run Transcript Check** (next to the other process actions) re-reviews the episode's
written transcripts and applies any new high-confidence findings — useful after editing
the transcripts by hand, or when the check failed during the run (bad key, quota,
network).

Quotes the model can't point to verbatim in the transcript are discarded as
hallucinations rather than applied or shown. Verdicts are cached per transcript content,
so a re-check is free until the transcript actually changes; check failures surface as a
warning and never block the run.

### AI Clip Suggestions

With an LLM key configured, the run also sends the whole transcript in a single request
and asks for up to 10 shareable moments — categorised as funny moment / hot take / story
/ wholesome, each with a hook title and a one-line reason shown on the suggestion card.
These replace the heuristic suggestions; the heuristics remain as the fallback when no
key is set or the request fails.

The model answers with verbatim opening/closing quotes, which are matched against the
episode's `transcript.vtt` cues to derive precise clip timings — a clip whose quotes
can't be located is discarded, so timings are never guessed. **Re-generate Clip
Suggestions** re-runs the selection against the episode's written transcripts (cached by
content, like the check, so it only costs a request after the transcript changes).

On Gemini's free tier (a handful of requests per minute, ~20 per day) the first pass over
a full episode costs about 3 requests — rate-limit responses are retried using the wait
time Google's error suggests. Subsequent discoveries hit the cache and are instant. Free
tier quotas are per model, so if you hit the daily cap, pointing `llm.model` at another
model (e.g. `gemini-3.5-flash` or `gemini-3.5-flash-lite`) gets a fresh quota bucket.

Persistent per-chapter image overrides live in `data/chapter-image-overrides.json`. That
path is not configurable: it is defined once in `utils.js` and shared by the UI that
writes overrides and the pipeline that reads them. The images themselves are stored in
`.cache/postprocess/manual-images/`. Both are gitignored and local to your machine.

Everything else under `.cache/postprocess/` is scratch. Per-run work directories are
pruned automatically after 24 hours, and a run's chapter MP4 segments are deleted as soon
as the video finishes, so the directory should stay small. Deleting it by hand is safe
apart from `manual-images/`, which your saved overrides point at.

### Tests

```bash
npm run test:postprocess
```

Plain `node --test` files alongside the code they cover. They need `ffmpeg` on PATH, since
`pipeline.test.js` builds a real chaptered MP3 as a fixture. Nothing touches the site
content, your Episodes folder or the repo's `.cache` — every test works in a temp
directory.

### TODOs

- Electron wrapper around the UI, so the tool runs as a desktop app instead of a local server plus browser tab.

### Clip Workflow TODOs

- Add a playback/progress bar overlay to clips for social-style presentation.
