# Podcast Driven Development

Code for the PDD site

## Dev

* `yarn` to install dependencies
* Edit `content/episode/` files
* Upload mp3 file
* Run `yarn dev` 
* Access `localhost:1313`

## Deploy

Deploy is done with `yarn build` but it is handled by circleci in the `.circleci/config.yml` file, automatically built and pushed to production server.