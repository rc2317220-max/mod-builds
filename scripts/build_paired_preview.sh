#!/usr/bin/env bash
# Trusted, paired build for the Preview 4 fork: the client and its compiler base
# use a unique identity and the very same game libraries. No user mod runs here.
set -euo pipefail
[[ "$BUILD" =~ ^[0-9a-f]{40}$ ]]
test "$ABI" = arm64-v8a
test "$PROFILE" = fast
repo_scripts=$(realpath "$(dirname "$0")")
root="$HOME/store"
source="$root/source"
ndk=27.3.13750724
export ANDROID_HOME="$HOME/android"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$ndk"
test -d "$ANDROID_NDK_HOME"
mkdir -p "$root"
git init -q "$source"
git -C "$source" fetch --depth 1 https://github.com/starling-client/starling cac7bf64590fb38b4badee90f1f09848ce7f8daa
git -C "$source" checkout -q --detach FETCH_HEAD
test "$(git -C "$source" rev-parse HEAD)" = cac7bf64590fb38b4badee90f1f09848ce7f8daa
python3 "$repo_scripts/patch_preview_client.py" "$source"
cd "$source"
rm -rf "$HOME/.rustup" "$HOME/.cargo"
curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none
. "$HOME/.cargo/env"
GITHUB_ENV='' bash tools/ci/rustup_install.sh --profile minimal --component rust-src --target aarch64-linux-android
cargo install cargo-ndk --version 3.5.4 --locked
python3 tools/android_native_sdk.py prepare
export SUNRISE_GAME_BUILD_ID="$BUILD"
export HORIZON_GAME_BUILD_ID="$BUILD"
export RUSTFLAGS="-C prefer-dynamic"
export CARGO_BUILD_JOBS=3
env -i HOME="$HOME" PATH="$HOME/.cargo/bin:/usr/bin:/bin" LANG=C.UTF-8 \
  ANDROID_HOME="$ANDROID_HOME" ANDROID_NDK_HOME="$ANDROID_NDK_HOME" \
  SUNRISE_GAME_BUILD_ID="$BUILD" HORIZON_GAME_BUILD_ID="$BUILD" \
  CARGO_BUILD_JOBS=3 RUSTFLAGS="-C prefer-dynamic" \
  python3 packaging/android/build_apk.py --abi "$ABI" --profile "$PROFILE" --library-only
# Package exactly that build, with a distinct .dev application ID (no replacement of Preview).
python3 packaging/android/build_apk.py --abi "$ABI" --profile "$PROFILE" --no-build --dev
apk="$source/target/android/starling-dev-0.9.0-arm64-v8a.apk"
test -s "$apk"
"$ANDROID_HOME/build-tools/35.0.0/apksigner" verify "$apk"
"$ANDROID_HOME/build-tools/35.0.0/aapt2" dump badging "$apk" | grep "package: name='io.github.juanluci.starling.dev'"
cp "$apk" "$RUNNER_TEMP/RustPG-Sunrise-Preview4-arm64.apk"
sha256sum "$RUNNER_TEMP/RustPG-Sunrise-Preview4-arm64.apk"
# Every shipped Rust dependency is copied from the paired APK only after comparing
# it byte-for-byte to the actual base build. The reference is read-only in phone jobs.
python3 - "$apk" "$BUILD" <<'PY'
import os, pathlib, sys, zipfile
sys.path.insert(0, "packaging/android")
import build_apk
source = pathlib.Path.cwd()
apk, build = sys.argv[1:]
target = source / "target" / "aarch64-linux-android" / "fast" / f"lib{build_apk.LIBRARY}.so"
reference = source / ".release-verified"
reference.mkdir()
made = build_apk.rust_dylibs(pathlib.Path(os.environ["ANDROID_NDK_HOME"]), target, reference)
made[f"lib{build_apk.LIBRARY}.so"] = source / "target/android" / f"lib{build_apk.LIBRARY}.so"
assert "libmod_vocab.so" in made and "libsunrise_mod_host.so" in made, made
with zipfile.ZipFile(apk) as z:
    for name, file in sorted(made.items()):
        raw = z.read(f"lib/arm64-v8a/{name}")
        assert file.read_bytes() == raw, f"Mismatch {name}"
        (reference / name).write_bytes(raw)
        print("Paired exact:", name)
(reference / "paired-build-id").write_text(build + "\n")
PY
# The local debug signing key is not a build input, and must never go into the cache.
find "$source/target/android" -maxdepth 1 -type f \( -name '*.keystore' -o -name '*.jks' -o -name '*.apk' -o -name '*.idsig' \) -delete
mv "$HOME/.cargo" "$root/cargo"
du -sh "$source/target" "$root/cargo" "$HOME/android" "$HOME/.rustup"
