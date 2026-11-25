#!/usr/bin/env python3
"""Strict per-mod ELF dependency verification for the official 0.9.0 ARM64 APK.
A mismatched host is not a usable link dependency. Check actual link closure, not
just exported names. Never execute a mod binary.
"""
import hashlib
import os
import pathlib
import re
import subprocess
import sys
import tempfile

BUILD = "ff303502a4f7982551a0e0d3622d9268efe9e829"
ABI = "arm64-v8a"
APK_SHA = "fd31e8d90a0e787c315846ddaa81e66cc916607e67cba702658d2d569689a571"
LIBS = {"libhorizon_android.so", "libhorizon_core.so", "libhorizon_engine_slots.so",
        "libhorizon_mod_host.so", "libhorizon_mod_runtime.so", "libmod_api.so",
        "libmod_points.so", "libmod_vocab.so", "libemutls.so"}
HOST = "libhorizon_mod_host.so"

def sha(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()

def run(tool, *args):
    return subprocess.check_output([str(tool), *map(str, args)], text=True)

def needed(readelf, path):
    return set(re.findall(r"\(NEEDED\)\s+Shared library: \[([^\]]+)\]", run(readelf, "-d", path)))

def symbols(nm, path, defined):
    flag = "--defined-only" if defined else "--undefined-only"
    return {s.strip().split("@")[0] for s in run(nm, "-D", flag, "--format=just-symbols", path).splitlines() if s.strip()}

def verify(source, library, profile, reference, paired=False):
    ndk = pathlib.Path(os.environ["ANDROID_NDK_HOME"])
    binpath = ndk / "toolchains/llvm/prebuilt/linux-x86_64/bin"
    readelf, strip, nm = (binpath / n for n in ("llvm-readelf", "llvm-strip", "llvm-nm"))
    libs = {p.name for p in reference.glob("*.so")} if paired else LIBS
    host = "libsunrise_mod_host.so" if paired else HOST
    required = {host, "libsunrise_android.so", "libemutls.so", "libmod_vocab.so"} if paired else LIBS
    if not reference.is_dir() or not required <= {p.name for p in reference.glob("*.so")}:
        raise ValueError("APK reference is missing or incomplete")
    header = run(readelf, "-h", library)
    if not re.search(r"Machine:\s+AArch64", header):
        raise ValueError("mod is not AArch64 ELF")
    target = source / "target/aarch64-linux-android"
    profile_dir = target / profile
    dirs = (profile_dir / "deps", profile_dir, target / "emutls")
    sysroot = ndk / "toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android/26"
    systems = {p.name for p in sysroot.glob("*.so")}
    pending = list(needed(readelf, library))
    visited = set()
    checked = set()
    available = set()
    unresolved = symbols(nm, library, False)
    with tempfile.TemporaryDirectory() as tmp:
        while pending:
            name = pending.pop()
            if name in visited:
                continue
            visited.add(name)
            if name in libs:
                actual = next((d/name for d in dirs if (d/name).is_file()), None)
                if actual is None:
                    raise ValueError(f"linked game library not found: {name}")
                stripped = pathlib.Path(tmp)/name
                subprocess.run([str(strip), "--strip-unneeded", "-o", str(stripped), str(actual)], check=True)
                if sha(stripped) != sha(reference/name):
                    raise ValueError(f"linked game library is not identical to paired APK: {name}")
                checked.add(name)
                available.update(symbols(nm, reference/name, True))
                unresolved.update(symbols(nm, reference/name, False))
                pending.extend(needed(readelf, reference/name))
            elif name in systems:
                available.update(symbols(nm, sysroot/name, True))
            else:
                raise ValueError(f"unverified dynamic dependency: {name}")
    if "libmod_api.so" not in checked and "libmod_vocab.so" not in checked:
        raise ValueError("no verified Rust mod API dependency")
    if host not in checked:
        host_only = symbols(nm, reference/host, True) - available
        if unresolved & host_only:
            raise ValueError("mod references symbols exclusive to the unverified host")
    print(("Paired APK" if paired else "Official APK") + " link closure verified: " + ", ".join(sorted(checked)), flush=True)

if __name__ == "__main__":
    verify(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3], pathlib.Path(sys.argv[4]))
