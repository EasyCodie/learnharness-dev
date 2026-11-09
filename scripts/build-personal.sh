#!/usr/bin/env bash
# Build "LearnHarness Personal" from the latest committed main and install it
# in /Applications. Runs in a separate worktree, so the working copy and its
# checked-out branch are never touched. See electron-builder.personal.yml.
set -euo pipefail

APP_NAME="LearnHarness Personal"
REPO="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
BUILD_DIR="$HOME/Library/Caches/learnharness-personal-build"
INSTALLED="/Applications/$APP_NAME.app"
SUPPORT="$HOME/Library/Application Support"

if pgrep -f "$INSTALLED/Contents/MacOS/" >/dev/null; then
	echo "Quit $APP_NAME first, then rerun." >&2
	exit 1
fi

if [ -d "$BUILD_DIR" ]; then
	git -C "$BUILD_DIR" checkout --detach --force main
	git -C "$BUILD_DIR" clean -fdx --exclude=node_modules
else
	git -C "$REPO" worktree add --detach "$BUILD_DIR" main
fi
echo "Building main @ $(git -C "$BUILD_DIR" log -1 --format='%h %s')"

cd "$BUILD_DIR"
npm ci
rm -rf dist .next/standalone
npx next build
node scripts/smoke-provider-runtime.mjs
node scripts/build-server.mjs
node scripts/smoke-server.mjs
npx electron-builder --mac --arm64 --config electron-builder.personal.yml

rm -rf "$INSTALLED"
ditto "dist/mac-arm64/$APP_NAME.app" "$INSTALLED"

# First install only: seed with the official app's learning records.
if [ ! -e "$SUPPORT/$APP_NAME/data" ] && [ -d "$SUPPORT/LearnHarness/data" ]; then
	mkdir -p "$SUPPORT/$APP_NAME"
	cp -R "$SUPPORT/LearnHarness/data" "$SUPPORT/$APP_NAME/data"
	echo "Copied the official app's data into $APP_NAME."
fi

echo "Installed $INSTALLED"
