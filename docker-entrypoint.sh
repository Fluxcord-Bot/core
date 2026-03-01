#!/bin/sh
set -e
pnpm run migrate
exec pnpm run start