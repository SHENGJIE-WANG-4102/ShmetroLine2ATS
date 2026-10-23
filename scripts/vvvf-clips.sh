#!/bin/sh
# Cut the local 02A05 inverter takes used by src/ui/vvvf.ts from p02
# (BV1VGZiBPEjt p2, 48 kHz WAV) and the optional source bank into
# public/sounds/vvvf/. The recordings are third-party material and are not in
# the repository; the time ranges match the tables in src/data/vvvf.ts.
#   usage: scripts/vvvf-clips.sh path/to/p02.wav [work/recordings/bilibili]
# Optional second directory holds post-p1.m4a / pre-1.m4a / pre-2.m4a.
set -e
src="${1:?usage: $0 path/to/p02.wav}"
out="$(dirname "$0")/../public/sounds/vvvf"
mkdir -p "$out"
# a complete start under power, and a complete electric-brake stop
ffmpeg -v error -y -ss 6.2 -to 39.6 -i "$src" -ac 1 -c:a libmp3lame -b:a 112k "$out/traction.mp3"
ffmpeg -v error -y -ss 66.0 -to 96.8 -i "$src" -ac 1 -c:a libmp3lame -b:a 112k "$out/brake.mp3"
echo "wrote $out/traction.mp3 and $out/brake.mp3"

if [ -n "${2:-}" ]; then
  bank="$2"
  # Absolute times in the four source files; measured tables are relative to these cuts.
  ffmpeg -v error -y -ss 27.2 -to 51.7 -i "$bank/post-p1.m4a" -ac 1 -c:a libmp3lame -b:a 112k "$out/post-p1-traction.mp3"
  ffmpeg -v error -y -ss 91.4 -to 121.6 -i "$bank/post-p1.m4a" -ac 1 -c:a libmp3lame -b:a 112k "$out/post-p1-brake.mp3"
  ffmpeg -v error -y -ss 29.6 -to 54.7 -i "$bank/pre-1.m4a" -ac 1 -c:a libmp3lame -b:a 112k "$out/pre-1-traction.mp3"
  ffmpeg -v error -y -ss 99 -to 157 -i "$bank/pre-1.m4a" -ac 1 -c:a libmp3lame -b:a 112k "$out/pre-1-brake.mp3"
  ffmpeg -v error -y -ss 25 -to 45 -i "$bank/pre-2.m4a" -ac 1 -c:a libmp3lame -b:a 112k "$out/pre-2-traction.mp3"
  ffmpeg -v error -y -ss 86 -to 126.2 -i "$bank/pre-2.m4a" -ac 1 -c:a libmp3lame -b:a 112k "$out/pre-2-brake.mp3"
  echo "wrote six additional 02A05 local-only clips"
fi
