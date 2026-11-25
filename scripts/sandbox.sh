#!/usr/bin/env bash
# Compile v2's builds (scripts/mod_lib.py) in a sandbox, as build.yml's are (mod_build_sandbox.sh in
# Starling): a mod's code goes into the compiler, and `include_bytes!` reads any file it can see. So it
# runs with no network, unable to gain privileges, in namespaces of its own (made with sudo, given up
# before anything of the mods runs), over a home folder that holds only what the build needs: none of the
# runner's own files, its workspace or its tokens. The base (store_base.sh: the game's checkout with its
# Cargo build, and Cargo's home) is seen through a layer of its own, thrown away after, so a build can't
# change what a later one starts from.
#
#   sandbox.sh JOBS MODS RESULT     mod_lib.py's `build`, with BUILD, ABI and PROFILE
set -uo pipefail

jobs=$(realpath "$1") mods=$(realpath "$2")
mkdir -p "$3"
result=$(realpath "$3")
scripts=$(realpath "$(dirname "$0")")
seconds=${SANDBOX_SECONDS:-3000}
layer=$HOME/store-layer
sudo -n rm -rf "$layer"
mkdir -p "$layer"

sudo -n timeout --kill-after=10 "$seconds" \
  unshare --net --mount --pid --fork --kill-child --propagation private bash -euc '
home=$1 uid=$2 gid=$3 jobs=$4 mods=$5 result=$6 scripts=$7 layer=$8 build=$9 abi=${10} profile=${11}
mount -t proc proc /proc
mount -t tmpfs -o mode=1777 tmpfs /tmp
ndk=$(ls "$home/android/ndk" | sort | tail -1)

# What the build may see, set aside before the home folder goes.
keep=/mnt
mount -t tmpfs tmpfs "$keep"
place() { mkdir -p "$keep/$1"; mount --bind "$2" "$keep/$1"; }
layered() {
  mkdir -p "$layer/$1/upper" "$layer/$1/work" "$keep/$1"
  chown "$uid:$gid" "$layer/$1/upper"
  mount -t overlay overlay -o "lowerdir=$2,upperdir=$layer/$1/upper,workdir=$layer/$1/work" "$keep/$1"
}
place rustup "$home/.rustup"
place android "$home/android"
layered source "$home/store/source"
layered cargo "$home/store/cargo"
place scripts "$scripts"
place mods "$mods"
place result "$result"
cp "$jobs" "$keep/jobs.json"

mount -t tmpfs -o "mode=755,uid=$uid,gid=$gid" tmpfs "$home"
back() {
  mkdir -p "$home/$2"
  mount --move "$keep/$1" "$home/$2"
  [ "$3" = rw ] || mount -o remount,bind,ro "$home/$2"
}
back rustup .rustup ro
back android android ro
# Where store_base.sh built it: Cargo keeps its build by the absolute path of each package, and each build script
# holds the folder of its package. Elsewhere Cargo built the whole game again in here, and the build script of
# horizon-prepare read its sources from where they no longer were (2026-11-20). No apostrophe in this script: it is
# inside single quotes.
back source store/source rw
source_path="$home/store/source"
sdk_path="$home/android"
if [ "$build" = "ff303502a4f7982551a0e0d3622d9268efe9e829" ] && [ "$abi" = arm64-v8a ]; then
  source_path="$home/work/starling/starling"
  mkdir -p "$source_path"
  mount --bind "$home/store/source" "$source_path"
  sdk_path=/usr/local/lib/android/sdk
  mkdir -p "$sdk_path"
  mount --bind "$home/android" "$sdk_path"
  mount -o remount,bind,ro "$sdk_path"
fi
back cargo .cargo rw
back scripts scripts ro
back mods mods ro
back result result rw
cp "$keep/jobs.json" "$home/jobs.json"
chown "$uid:$gid" "$home/jobs.json"
umount "$keep"

cd /tmp
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs \
  --bounding-set=-all --inh-caps=-all \
  env -i HOME="$home" PATH="$home/.cargo/bin:/usr/bin:/bin" CARGO_NET_OFFLINE=true LANG=C.UTF-8 \
  ANDROID_HOME="$sdk_path" ANDROID_NDK_HOME="$sdk_path/ndk/$ndk" CARGO_BUILD_JOBS=3 \
  BUILD="$build" ABI="$abi" PROFILE="$profile" MOD_LIB_SOURCE="$source_path" \
  python3 -I "$home/scripts/mod_lib.py" build "$home/jobs.json" "$home/mods" "$home/result"
' sandbox "$HOME" "$(id -u)" "$(id -g)" "$jobs" "$mods" "$result" "$scripts" "$layer" "${BUILD:-}" "${ABI:-}" \
  "${PROFILE:-fast}"
code=$?
# The layer holds root's files.
sudo -n rm -rf "$layer"
exit "$code"
