#!/bin/bash
# Build Alfred Black.app with the Command Line Tools only, ad-hoc sign it, and
# produce a .dmg. Usage: scripts/build-app.sh [version]
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:-$(date +%Y.%m.%d)}"
BUILD="$(date +%Y%m%d%H%M)"
APP="dist/Alfred Black.app"
swift build -c release 2>&1 | tail -3
rm -rf dist && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/AlfredBlack "$APP/Contents/MacOS/AlfredBlack"
# SwiftPM puts the resource bundle beside the binary; move it into the app.
bundle=$(ls -d .build/release/AlfredBlack_AlfredBlack.bundle 2>/dev/null || true)
if [ -n "$bundle" ]; then cp -R "$bundle" "$APP/Contents/Resources/"; fi
cp -R Sources/AlfredBlack/Resources/Fonts "$APP/Contents/Resources/Fonts"
[ -f Support/AppIcon.icns ] && cp Support/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
# Dictation: whisper.cpp's framework (the SwiftPM binary target) and one bundled model,
# fetched once into a cache and verified — never committed to the repo.
MODEL=ggml-base-q5_1.bin; MODEL_SHA=422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898
CACHE="${ALFRED_MAC_MODEL_CACHE:-$HOME/Library/Caches/alfred-mac}"; mkdir -p "$CACHE"
if [ ! -f "$CACHE/$MODEL" ] || [ "$(shasum -a 256 "$CACHE/$MODEL" | cut -c1-64)" != "$MODEL_SHA" ]; then
  echo "fetching $MODEL"; curl -sSL -o "$CACHE/$MODEL" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL"
  [ "$(shasum -a 256 "$CACHE/$MODEL" | cut -c1-64)" = "$MODEL_SHA" ] || { echo "model checksum mismatch"; exit 1; }
fi
mkdir -p "$APP/Contents/Resources/Models" "$APP/Contents/Frameworks"
cp "$CACHE/$MODEL" "$APP/Contents/Resources/Models/$MODEL"
cp -R .build/release/whisper.framework "$APP/Contents/Frameworks/whisper.framework"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" Support/Info.plist > "$APP/Contents/Info.plist"
# Ad-hoc signature: runs on this Mac; other Macs need right-click → Open once
# (or a Developer ID + notarization, which needs an Apple credential).
codesign --force --deep --sign - "$APP"   # identifiers come from each bundle's Info.plist
codesign --verify --deep --strict "$APP" && echo "signed (ad-hoc)"
hdiutil create -quiet -volname "Alfred Black" -srcfolder "$APP" -ov -format UDZO "dist/AlfredBlack-$VERSION.dmg"
echo "built: $APP"; echo "dmg:   dist/AlfredBlack-$VERSION.dmg"
