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

### Configuration

- Main config: `postprocess.config.json`
- Persistent chapter image overrides: `data/chapter-image-overrides.json`

Update `seasonMap` in `postprocess.config.json` if you use additional seasons.

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

Not yet implemented in this phase:

- Embedding per-chapter images directly into MP3 chapter metadata

### Local Web UI

```bash
npm run postprocess:ui
```

Then open `http://localhost:4173`.

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
