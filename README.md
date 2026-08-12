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

`profanityWords` from config is unioned with a hardcoded default list, so it can only add
words, never remove them.

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
- Preview clips before approving them: range-serve the MP3 so each suggestion card has a play button, instead of approving from a text summary alone.
- Add a cancel button for in-progress clip generation. Now that ffmpeg runs async, an in-flight run can be killed instead of needing a server restart.
- Decide how the status file should behave when a CLI run and the UI server are both open. They are separate processes writing the same `video-status.json`, and each fully overwrites it.

### Clip Workflow TODOs

- Improve clip suggestion cards so approval is meaningful. The generator already returns `reason`, `speaker` and the full `text`; the card just doesn't render them, so this is a UI-only change.
- Add a playback/progress bar overlay to clips for social-style presentation.
- Add subtitles, sliced from the existing episode VTT and rebased to the clip start.
- Replace the regex/keyword scoring in `clip-suggestions.js` with an LLM pass over the transcript. The current `HOOK_WORDS` heuristics are why summaries land on things like "That".
- Snap clip boundaries to sentence or VTT cue edges instead of the flat `trailingContextSeconds: 12` pad, so clips stop cutting mid-word.
