#!/bin/bash
cd "$(dirname "$0")"
git pull
npm i
# X-Bruv-Repo-Path header is only honored for paths under these roots.
export BRUV_ALLOWED_ROOTS="${BRUV_ALLOWED_ROOTS:-$PWD/../NodeBruv/repos}"
node bin/bruv.js server >bruv-api.log 2>&1 &
