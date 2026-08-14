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

The weekly episode tool — discovery, AI transcript checks, clip generation and the
desktop app — is documented in [scripts/postprocess/](scripts/postprocess/README.md).

```bash
npm run postprocess
```
