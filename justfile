# flamebeat common tasks

default:
    @just --list

# download the CC-licensed test track into assets/audio/
fetch:
    scripts/fetch-test-track.sh

# analyze an audio file -> web/timelines/<stem>.json (+ diagnostic PNG in analysis/out/); meter e.g. 9/8
analyze file meter="4/4":
    cd analysis && uv run python analyze.py "{{absolute_path(file)}}" -o "{{justfile_directory()}}/web/timelines/{{file_stem(file)}}.json" --meter {{meter}}
    cd analysis && uv run python plot.py "{{justfile_directory()}}/web/timelines/{{file_stem(file)}}.json" -o "out/{{file_stem(file)}}.png"

# analyze every audio file in assets/audio/
analyze-all:
    for f in assets/audio/*.mp3 assets/audio/*.ogg assets/audio/*.wav assets/audio/*.flac; do [ -e "$f" ] && just analyze "$f" || true; done

# serve the repo root (web/ + assets/audio/) at http://localhost:8000/web/ (with HTTP Range, for seeking)
serve port="8000":
    cd analysis && uv run python ../scripts/serve.py {{port}}

# install dev-only node tooling (playwright-core) for the headless checks
tools-install:
    cd tools && npm install --no-audit --no-fund

# node unit checks of timeline sampling + mapping against a generated timeline
test track="Funkorama":
    cd tools && node test-sync.mjs ../web/timelines/{{track}}.json

# headless Chromium (WebGPU via SwiftShader) end-to-end check; needs `just serve` running
verify port="8000":
    cd tools && node verify.mjs ../analysis/out/verify http://localhost:{{port}}/web/
    cd tools && node keys.mjs ../analysis/out/verify/keys.png http://localhost:{{port}}/web/
    cd tools && node routes.mjs ../analysis/out/verify/routes.png http://localhost:{{port}}/web/
    cd tools && node mappings.mjs http://localhost:{{port}}/web/
    cd tools && node look.mjs ../analysis/out/verify/look.png http://localhost:{{port}}/web/
    cd tools && node video.mjs ../analysis/out/verify http://localhost:{{port}}/web/
