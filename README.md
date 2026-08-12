# The Harvest Season

Code for the THS site

## Dev

- `yarn` to install dependencies
- Edit `content/episode/` files
- Upload mp3 file
- Run `yarn dev`
- Access `localhost:1313`

## Deploy

Deploy is done with `yarn build` but it is handled by circleci in the `.circleci/config.yml` file, automatically built and pushed to production server.

## Episode Post-Processing (WIP)

Initial implementation lives in `scripts/postprocess/`.

### Prerequisites

- Node 24+
- `ffmpeg` and `ffprobe` available in PATH
- `python3` available in PATH (used to embed per-chapter images into the MP3)

### Configuration

- Main config: `postprocess.config.json`
- Persistent chapter image overrides: `data/chapter-image-overrides.json`

### CLI Dry Run

```bash
npm run postprocess:dry -- \
	--mp3 /absolute/path/to/ths-11-18.mp3 \
	--chapters "/absolute/path/Tangent Factories - Chapter Info.txt" \
	--transcript-md "/absolute/path/Tangent Factories.md" \
	--transcript-vtt "/absolute/path/Tangent Factories.vtt"
```

### CLI Full Run

```bash
npm run postprocess -- \
	--mp3 /absolute/path/to/ths-11-18.mp3 \
	--chapters "/absolute/path/Tangent Factories - Chapter Info.txt" \
	--transcript-md "/absolute/path/Tangent Factories.md" \
	--transcript-vtt "/absolute/path/Tangent Factories.vtt"
```

This currently does the following:

- Validates expected filenames and required tools
- Parses chapter timings
- Resolves chapter images from overrides, IGN, Steam, then MP3 cover fallback
- Generates `index.md`, `transcript.md`, and `transcript.vtt` in the episode folder
- Generates a 1080x1080 MP4 chapter-image video
- Runs warning-only inappropriate word checks on transcripts
- Embeds per-chapter images directly into MP3 chapter metadata (via `embed_chapter_images.py`)

Per-chapter images are used for the MP3 chapter metadata and the full-episode MP4. Clip videos deliberately do not use them: they use the show logo from the project `Assets` folder, falling back to the MP3 cover art.

### Local Web UI

```bash
npm run postprocess:ui
```

Then open `http://localhost:4173`.

### TODOs

- Electron wrapper around the UI, so the tool runs as a desktop app instead of a local server plus browser tab.
- Fix the documentation in this file so it matches the tool (see Known Bugs: every CLI example is currently wrong).
- Preview clips before approving them: range-serve the MP3 so each suggestion card has a play button, instead of approving from a text summary alone.
- Add a cancel button for in-progress clip generation. Now that ffmpeg runs async, an in-flight run can be killed instead of needing a server restart.
- Decide how the status file should behave when a CLI run and the UI server are both open. They are separate processes writing the same `video-status.json`, and each fully overwrites it.
- Add tests for the untested fragile parts, especially `parseTranscriptSegments`, `parseId3ChapterVisibility`, and the season/date inference in `sequence-inference.js`.

### Clip Workflow TODOs

- Improve clip suggestion cards so approval is meaningful. The generator already returns `reason`, `speaker` and the full `text`; the card just doesn't render them, so this is a UI-only change.
- Decide whether to keep the burned-in `drawtext` summary label at all. It is currently never drawn (see Known Bugs) so removing it is also an option.
- Add the remaining overlays if the label is kept: episode name, episode date, and a playback/progress bar for social-style presentation.
- Add subtitles, sliced from the existing episode VTT and rebased to the clip start.
- Replace the regex/keyword scoring in `clip-suggestions.js` with an LLM pass over the transcript. The current `HOOK_WORDS` heuristics are why summaries land on things like "That".
- Snap clip boundaries to sentence or VTT cue edges instead of the flat `trailingContextSeconds: 12` pad, so clips stop cutting mid-word.

### Known Bugs

Documentation:

- Every CLI example in this file is broken. `postprocess:ui` and `postprocess:episode` are not defined in `package.json`, and `cli.js` rejects `--mp3`, `--chapters`, `--transcript-md`, `--transcript-vtt`, `--season`, `--episode` and `--publish-date` as unsupported options. The only working invocations are `npm run postprocess` and `npm run postprocess:dry`, with `--dry-run`, `--new-season` and `--episode-number`.
- The docs claim chapter images resolve "from overrides, IGN, Steam, then MP3 cover fallback". `image-resolver.js` only checks manual overrides before falling back to the MP3 cover; there is no IGN or Steam image lookup in the code at all.

Clip generation:

- `parseTranscriptSegments` strips `And|But|So|Yeah|Yes|Okay|Well` with a global regex, so the words are removed mid-sentence, not just as lead-ins. `"I was so tired and honestly..."` becomes `"I was  tired  honestly..."`, leaving doubled spaces behind. This corrupts both the card summaries and the burned-in label.
- Clip dedup compares only `startSeconds` with a 20s threshold, so accepted clips can overlap by 20-30s of identical audio.
- The `drawtext` label is never rendered on this machine: the installed ffmpeg has no `drawtext` filter, so every clip silently takes the no-label fallback path.
- The label is a single unwrapped `drawtext` line at fontsize 52 on a 1080px frame, fed a summary of up to 180 characters. It would overflow the frame if `drawtext` were available.
- The macOS-only font path `/System/Library/Fonts/Helvetica.ttc` is hardcoded in `video.js`.

Publish dates:

- `timezoneOffset` is a fixed `+01:00` in the config, so episodes published between late October and late March get an offset an hour off from UK local time.
- `inferPublishDateForEpisode` returns a UTC `...Z` string rather than the configured offset format used everywhere else, and adds a flat 7x24h per week so it drifts across DST boundaries.

Web UI:

- Status polling captures an index into the status-line array, but `resetStatus()` empties that array. If auto-discovery re-runs (it fires on input changes) while a render or clip generation is in progress, progress updates land on the wrong line or are dropped.
- `/api/image` serves any absolute path it is given, including non-image files, and the server binds to all network interfaces rather than localhost. Anyone on the same network can read arbitrary files while the tool is running.
- On a failed run the UI prints "Generation completed" before printing the error, because the spinner is stopped before `result.error` is checked.

Other:

- `postprocess-report.json` is written before `report.videoStatus` is set, so the saved report never contains the video status.
- Profanity words in `postprocess.config.json` are unioned with a hardcoded default list, so a word cannot be removed via config.

### Quick Episode Flow (Season + Episode Only)

If your episode assets are in the configured Episodes folder and use the standard names, run:

```bash
npm run postprocess:episode -- --season 11 --episode 18
```

This will:

- Find the episode folder automatically under the configured Episodes root
- Detect the MP3, chapter info, transcript MD, and transcript VTT files
- Launch the local UI automatically with all fields prefilled
- Auto-run the pipeline immediately (full run)

To open UI and auto-run in dry-run mode instead:

```bash
npm run postprocess:episode -- --season 11 --episode 18 --dry-run
```

### Fastest Flow (Infer Season + Episode)

If you omit season and episode, the tool infers the next episode code using existing site episodes and these rules:

- max 26 episodes per season
- first episode published in January and July starts a new season
- otherwise increment episode number

Open prefilled UI using inference:

```bash
npm run postprocess:episode
```

This inferred flow also auto-runs by default. Use `--dry-run` to switch to preview mode.

Run pipeline directly using inference:

```bash
npm run postprocess:dry
```

You can still override inferred publish date if needed:

```bash
npm run postprocess:episode -- --publish-date 2026-07-01T19:00:00+01:00
```
