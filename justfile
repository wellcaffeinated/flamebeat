# flamebeat common tasks

default:
    @just --list

# download the CC-licensed test track into assets/audio/
fetch:
    scripts/fetch-test-track.sh

# analyze an audio file -> web/timelines/<stem>.json (+ diagnostic PNG in analysis/out/)
analyze file:
    cd analysis && uv run python analyze.py "{{absolute_path(file)}}" -o "{{justfile_directory()}}/web/timelines/{{file_stem(file)}}.json"
    cd analysis && uv run python plot.py "{{justfile_directory()}}/web/timelines/{{file_stem(file)}}.json" -o "out/{{file_stem(file)}}.png"

# analyze every audio file in assets/audio/
analyze-all:
    for f in assets/audio/*.mp3 assets/audio/*.ogg assets/audio/*.wav assets/audio/*.flac; do [ -e "$f" ] && just analyze "$f" || true; done

# serve the repo root (web/ + assets/audio/) at http://localhost:8000/web/ (with HTTP Range, for seeking)
serve port="8000":
    cd analysis && uv run python ../scripts/serve.py {{port}}
