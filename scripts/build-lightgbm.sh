#!/bin/sh
# Build the official LightGBM CLI for the same OpenWrt 24.10.5 musl targets as J-Box.
set -eu
[ "$#" -eq 2 ] || { echo "usage: $0 <x64|arm64> <output-binary>" >&2; exit 2; }
ARCH=$1
OUTPUT=$2
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CACHE=${JBOX_LIGHTGBM_CACHE:-$ROOT/.build-cache/lightgbm}
mkdir -p "$CACHE" "$(dirname -- "$OUTPUT")"
case "$ARCH" in
  x64)
    PLATFORM=x86/64
    SDK=openwrt-sdk-24.10.5-x86-64_gcc-13.3.0_musl.Linux-x86_64
    TOOLCHAIN=toolchain-x86_64_gcc-13.3.0_musl
    COMPILER=x86_64-openwrt-linux-musl
    ;;
  arm64)
    PLATFORM=armsr/armv8
    SDK=openwrt-sdk-24.10.5-armsr-armv8_gcc-13.3.0_musl.Linux-x86_64
    TOOLCHAIN=toolchain-aarch64_generic_gcc-13.3.0_musl
    COMPILER=aarch64-openwrt-linux-musl
    ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 2 ;;
esac
SDK_ARCHIVE="$CACHE/$SDK.tar.zst"
SDK_DIR="$CACHE/$SDK"
SDK_URL="https://downloads.openwrt.org/releases/24.10.5/targets/$PLATFORM/$SDK.tar.zst"
if [ ! -d "$SDK_DIR/staging_dir/$TOOLCHAIN" ]; then
  curl -fL --retry 3 --connect-timeout 15 "$SDK_URL" -o "$SDK_ARCHIVE.part"
  mv "$SDK_ARCHIVE.part" "$SDK_ARCHIVE"
  SUMS="$CACHE/$SDK.sha256sums"
  curl -fsSL --retry 3 "https://downloads.openwrt.org/releases/24.10.5/targets/$PLATFORM/sha256sums" -o "$SUMS"
  python3 - "$SDK_ARCHIVE" "$SUMS" <<'PY'
import hashlib, pathlib, sys
archive, sums = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
name = archive.name
expected = next((line.split()[0] for line in sums.read_text().splitlines() if line.split()[-1].lstrip('*') == name), None)
if not expected or hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
    raise SystemExit(f'OpenWrt SDK SHA256 verification failed: {name}')
PY
  mkdir -p "$SDK_DIR"
  tar --zstd -xf "$SDK_ARCHIVE" -C "$SDK_DIR" --strip-components=1
fi
SRC="$CACHE/LightGBM-v4.7.0"
if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 --branch v4.7.0 --recurse-submodules https://github.com/lightgbm-org/LightGBM.git "$SRC"
fi
EXPECTED_COMMIT=8f7036f03627054d5a54a6f965b13f4b9ff2cb63
ACTUAL_COMMIT=$(git -C "$SRC" rev-parse HEAD)
[ "$ACTUAL_COMMIT" = "$EXPECTED_COMMIT" ] || { echo "LightGBM source commit mismatch: $ACTUAL_COMMIT" >&2; exit 1; }
BIN="$SDK_DIR/staging_dir/$TOOLCHAIN/bin"
STAGING_DIR="$SDK_DIR/staging_dir"
export STAGING_DIR
BUILD="$CACHE/build-$ARCH"
cmake -S "$SRC" -B "$BUILD" \
  -DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR="$([ "$ARCH" = x64 ] && echo x86_64 || echo aarch64)" \
  -DCMAKE_C_COMPILER="$BIN/$COMPILER-gcc" -DCMAKE_CXX_COMPILER="$BIN/$COMPILER-g++" \
  -DUSE_OPENMP=OFF -DUSE_MPI=OFF -DUSE_GPU=OFF -DBUILD_STATIC_LIB=ON -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD" --parallel "${JBOX_BUILD_JOBS:-2}"
cp "$SRC/lightgbm" "$OUTPUT"
"$BIN/$COMPILER-strip" "$OUTPUT"
chmod 0755 "$OUTPUT"
file "$OUTPUT"
