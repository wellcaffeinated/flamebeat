#!/usr/bin/env bash
# Download the flamebeat test track into assets/audio/ (gitignored).
# Track: "Funkorama" by Kevin MacLeod (incompetech.com), CC BY 3.0.
# Source + license verified on the Wikimedia Commons file page, see assets/ATTRIBUTION.md.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$root/assets/audio/Funkorama.mp3"
url="https://upload.wikimedia.org/wikipedia/commons/c/cf/Funkorama_%28ISRC_USUAN1100474%29.mp3"
mirror="https://incompetech.com/music/royalty-free/mp3-royaltyfree/Funkorama.mp3"
sha1="1861d9c36a93ba1a506ddd93e80188996a0857da"   # as published by Commons

mkdir -p "$(dirname "$dest")"

check() { echo "$sha1  $1" | sha1sum -c --status; }

if [[ -f "$dest" ]] && check "$dest"; then
  echo "already present: $dest"
  exit 0
fi

tmp="$dest.part"
for u in "$url" "$mirror"; do
  echo "downloading $u"
  if curl -fL --retry 3 -A "flamebeat-fetch/0.1" -o "$tmp" "$u" && check "$tmp"; then
    mv "$tmp" "$dest"
    echo "ok: $dest"
    exit 0
  fi
  echo "download failed or checksum mismatch from $u" >&2
done
rm -f "$tmp"
exit 1
