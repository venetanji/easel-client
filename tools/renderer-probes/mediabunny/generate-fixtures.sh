#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$here/fixtures"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'color=c=red:s=96x64:r=12:d=1' \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=1' \
  -map 0:v:0 -map 1:a:0 -t 1 \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
  -c:a aac -b:a 96k -shortest \
  "$here/fixtures/clip-a-12fps-red-440.mp4"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'color=c=blue:s=96x64:r=24:d=1' \
  -f lavfi -i 'sine=frequency=660:sample_rate=48000:duration=1' \
  -map 0:v:0 -map 1:a:0 -t 1 \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
  -c:a aac -b:a 96k -shortest \
  "$here/fixtures/clip-b-24fps-blue-660.mp4"

for fixture in "$here"/fixtures/*.mp4; do
  ffprobe -v error -show_entries stream=codec_type,codec_name,r_frame_rate,sample_rate \
    -show_entries format=duration -of json "$fixture"
done
