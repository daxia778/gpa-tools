#!/bin/bash
# GPA Tools — macOS App Bundle Installer
set -e

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HOME/Desktop/GPA Tools.app"

echo "🔧 Building GPA Tools..."
cd "$SRC_DIR"
cargo build --release

echo "📦 Creating app bundle at: $APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

cp "$SRC_DIR/target/release/gpa-tools" "$APP_DIR/Contents/MacOS/GPATools"
cp "$SRC_DIR/assets/Info.plist" "$APP_DIR/Contents/Info.plist"
cp "$SRC_DIR/assets/AppIcon.icns" "$APP_DIR/Contents/Resources/AppIcon.icns"
[ -f "$SRC_DIR/.env" ] && cp "$SRC_DIR/.env" "$APP_DIR/Contents/MacOS/.env"

# Copy existing database if present (preserves accounts)
if [ -f "$APP_DIR/Contents/MacOS/bridge.db" ]; then
    echo "📄 Existing database preserved"
fi

echo ""
echo "✅ GPA Tools.app installed to Desktop!"
echo "📌 Launch: open '$APP_DIR'"
echo ""
