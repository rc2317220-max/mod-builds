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
  # Cargo's path-dependency build-script fingerprint stores both the latest
  # mtime and its filename. A checkout with tied mtimes may select a
  # different filename after cache restore/OverlayFS, invalidating Naga and
  # 22 dependents. Set a unique whole-second maximum BEFORE compiling
  # trusted sources; no file bytes, Cargo fingerprints or ABI are edited.
  git diff --exit-code HEAD -- third_party/naga
  python3 - <<'PY'
import hashlib, os, pathlib, time
root = pathlib.Path("third_party/naga")
chosen = root / "build.rs"
assert chosen.is_file() and not chosen.is_symlink()
files = [p for p in root.rglob("*") if not p.is_symlink() and p.is_file()]
assert chosen in files
previous = max(p.stat().st_mtime_ns for p in files)
now = time.time_ns() // 1_000_000_000 * 1_000_000_000
if now <= previous:
    delay = (previous // 1_000_000_000 + 1) - time.time()
    if delay > 2:
        raise RuntimeError("unexpected future source timestamps")
    time.sleep(max(0, delay) + 0.05)
    now = time.time_ns() // 1_000_000_000 * 1_000_000_000
assert now > previous
before = hashlib.sha256(chosen.read_bytes()).hexdigest()
os.utime(chosen, ns=(chosen.stat().st_atime_ns, now))
assert hashlib.sha256(chosen.read_bytes()).hexdigest() == before
assert [p for p in files if p.stat().st_mtime_ns == now] == [chosen]
print("Unique newest Naga source:", chosen, now, "previous max:", previous)
PY
  git diff --exit-code HEAD -- third_party/naga
fi
printf "Warming with %s Cargo jobs\n" "$jobs"
# Cold static library build, as the original client requests one replacement .so.
# No prepare, no prefer-dynamic, no APK creation.
env -i HOME="$HOME" PATH="$HOME/.cargo/bin:/usr/bin:/bin" LANG=C.UTF-8 \
  ANDROID_HOME="$ANDROID_HOME" ANDROID_NDK_HOME="$ANDROID_NDK_HOME" \
  SUNRISE_GAME_BUILD_ID="$COMMIT" CARGO_BUILD_JOBS="$jobs" \
  python3 packaging/android/build_apk.py --abi arm64-v8a --profile fast --library-only
if [ "${1:-}" = "--turbo" ]; then
  # Verify the warmed base using the offline request environment before
  # the trusted cache can reach the existing publication/speed gates.
  log=$(mktemp)
  if ! env -i HOME="$HOME" PATH="$HOME/.cargo/bin:/usr/bin:/bin" LANG=C.UTF-8 \
    ANDROID_HOME="$ANDROID_HOME" ANDROID_NDK_HOME="$ANDROID_NDK_HOME" \
    SUNRISE_GAME_BUILD_ID="$COMMIT" CARGO_BUILD_JOBS="$jobs" CARGO_NET_OFFLINE=true \
    python3 packaging/android/build_apk.py --abi arm64-v8a --profile fast --library-only >"$log" 2>&1; then
    cat "$log"
    rm -f "$log"
    exit 1
  fi
  cat "$log"
  if grep -Eq '^[[:space:]]*Compiling[[:space:]]' "$log"; then
    rm -f "$log"
    echo "Trusted Turbo base is not Cargo-fresh; refusing cache publication" >&2
    exit 1
  fi
  rm -f "$log"
fi
mv "$HOME/.cargo" "$root/cargo"
du -sh "$root/source/target" "$root/cargo" "$HOME/android" "$HOME/.rustup"
