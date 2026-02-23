#!/bin/sh
set -e
bun run migrate.ts
exec bun index.ts