#!/bin/sh
# Hand the data directories to the app user, then become it.
#
# A volume mounted over DOWNLOAD_DIR or COOKIES_FILE's directory arrives owned
# by root (Fly mounts /data that way), and a process that is already the app
# user cannot take it: the server failed creating its download directory at
# import and never answered a health check. So the image starts as root, does
# only this, and drops privileges for good before anything else runs.
set -eu
if [ "$(id -u)" = "0" ]; then
  for dir in "${DOWNLOAD_DIR:-/tmp/siphon}" "$(dirname "${COOKIES_FILE:-/tmp/siphon/cookies.txt}")"; do
    mkdir -p "$dir"
    chown app:app "$dir"
  done
  # setpriv changes who the process is, not its environment, so HOME would
  # stay /root, which the app user cannot write — and yt-dlp's cache, the
  # YouTube player it otherwise fetches and solves again for every job, went
  # nowhere without a word.
  export HOME=/home/app
  exec setpriv --reuid=app --regid=app --init-groups -- "$@"
fi
exec "$@"
