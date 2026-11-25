#!/usr/bin/env bash
# Original Preview 4's whole-game compiler. Same isolation principles as upstream
# sandbox.sh, with separate cache and only a framed v1 request as input.
set -euo pipefail
body=$(realpath "$1")
mkdir -p "$2"
result=$(realpath "$2")
scripts=$(realpath "$(dirname "$0")")
layer="$HOME/preview4-v1-layer"
sudo -n rm -rf "$layer"
mkdir -p "$layer"
trap 'sudo -n rm -rf "$layer"' EXIT
sudo -n timeout --kill-after=10 "${SANDBOX_SECONDS:-3200}" \
  unshare --net --mount --pid --fork --kill-child --propagation private bash -euc '
home=$1 uid=$2 gid=$3 body=$4 result=$5 scripts=$6 layer=$7
mount -t proc proc /proc
mount -t tmpfs -o mode=1777 tmpfs /tmp
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
place result "$result"
cp "$body" "$keep/request.bin"
mount -t tmpfs -o "mode=755,uid=$uid,gid=$gid" tmpfs "$home"
back() {
  mkdir -p "$home/$2"
  mount --move "$keep/$1" "$home/$2"
  [ "$3" = rw ] || mount -o remount,bind,ro "$home/$2"
}
back rustup .rustup ro
back android android ro
back source store/source rw
back cargo .cargo rw
back scripts scripts ro
back result result rw
cp "$keep/request.bin" "$home/request.bin"
chmod 444 "$home/request.bin"
umount "$keep"
cd /tmp
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs \
  --bounding-set=-all --inh-caps=-all \
  env -i HOME="$home" PATH="$home/.cargo/bin:/usr/bin:/bin" CARGO_NET_OFFLINE=true LANG=C.UTF-8 \
  ANDROID_HOME="$home/android" ANDROID_NDK_HOME="$home/android/ndk/27.3.13750724" CARGO_BUILD_JOBS=3 \
  python3 -I "$home/scripts/preview4_whole_build.py" "$home/request.bin" "$home/result"
' sandbox "$HOME" "$(id -u)" "$(id -g)" "$body" "$result" "$scripts" "$layer"
