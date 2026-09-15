#!/bin/sh
set -e
# Volume yang dibuat Coolify/Docker biasanya milik root; pastikan user node bisa menulis DB & PDF.
STORAGE="${STORAGE_DIR:-/app/storage}"
mkdir -p "$STORAGE"
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$STORAGE" 2>/dev/null || true
  exec gosu node "$@"
fi
exec "$@"
