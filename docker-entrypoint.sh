#!/bin/sh
set -e
./node_modules/.bin/tsx ./migrate.ts
exec node ./index.js
