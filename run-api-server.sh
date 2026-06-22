#!/bin/bash
cd "$(dirname "$0")"
git pull
npm i
node bin/bruv.js server >bruv-api.log 2>&1 &
