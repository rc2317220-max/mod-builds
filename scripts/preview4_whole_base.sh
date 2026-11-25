#!/usr/bin/env bash
set -euo pipefail
COMMIT=cac7bf64590fb38b4badee90f1f09848ce7f8daa
scripts=$(cd "$(dirname "$0")" && pwd)
source "$scripts/preview4_jobs.sh"
jobs=$(preview4_jobs)
root="$HOME/store"
rm -rf "$root"
git init -q "$root/source"
git -C "$root/source" fetch -q --depth 1 https://github.com/starling-client/starling "$COMMIT"
git -C "$root/source" checkout -q --detach FETCH_HEAD
test "$(git -C "$root/source" rev-parse HEAD)" = "$COMMIT"
cd "$root/source"
export ANDROID_HOME="$HOME/android" ANDROID_NDK_HOME="$HOME/android/ndk/27.3.13750724"
test -d "$ANDROID_NDK_HOME"
rm -rf "$HOME/.rustup" "$HOME/.cargo"
curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none
. "$HOME/.cargo/env"
GITHUB_ENV='' bash tools/ci/rustup_install.sh --profile minimal --component rust-src --target aarch64-linux-android
cargo install cargo-ndk --version 3.5.4 --locked
cargo fetch --locked
if [ "${1:-}" = "--turbo" ]; then
  python3 -I "$scripts/preview4_whole_build.py" --prepare-base
fi
printf "Warming with %s Cargo jobs\n" "$jobs"
# Cold static library build, as the original client requests one replacement .so.
# No prepare, no prefer-dynamic, no APK creation.
env -i HOME="$HOME" PATH="$HOME/.cargo/bin:/usr/bin:/bin" LANG=C.UTF-8 \
  ANDROID_HOME="$ANDROID_HOME" ANDROID_NDK_HOME="$ANDROID_NDK_HOME" \
  SUNRISE_GAME_BUILD_ID="$COMMIT" CARGO_BUILD_JOBS="$jobs" \
  python3 packaging/android/build_apk.py --abi arm64-v8a --profile fast --library-only
mv "$HOME/.cargo" "$root/cargo"
du -sh "$root/source/target" "$root/cargo" "$HOME/android" "$HOME/.rustup"
