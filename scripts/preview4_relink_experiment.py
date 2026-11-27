#!/usr/bin/env python3
"""Prepare an isolated diagnostic variant of the original v1 compiler.
No APK changes, dynamic SDK, network access, or untrusted persistent cache.
Only the final cdylib's link flags change; all upstream rlibs retain their
original Cargo profile and rustflags. The ordinary v1 remains unchanged.
"""
import argparse
from pathlib import Path
import shutil

def once(s, old, new):
    if s.count(old) != 1:
        raise RuntimeError(f"unexpected source anchor: {old}")
    return s.replace(old, new, 1)

def main():
    p=argparse.ArgumentParser()
    p.add_argument("source",type=Path)
    p.add_argument("dest",type=Path)
    p.add_argument("--link-only",action="store_true")
    p.add_argument("--cache-control",action="store_true", help="Build trusted cached base without a request mod")
    a=p.parse_args()
    shutil.copytree(a.source,a.dest)
    sandbox=a.dest/"preview4_whole_sandbox.sh"
    s=sandbox.read_text()
    s=once(s,'CARGO_NET_OFFLINE=true LANG=C.UTF-8','CARGO_NET_OFFLINE=true LANG=C.UTF-8 CARGO_LOG=cargo::compiler::fingerprint=trace,cargo::core::compiler::fingerprint=trace CARGO_TERM_VERBOSE=true')
    sandbox.write_text(s)
    if a.cache_control:
        if a.link_only:
            p.error("cache control and link-only are mutually exclusive")
        build=a.dest/"preview4_whole_build.py"
        s=build.read_text()
        s=once(s, "    records = configure(body)\n", "    prepare_fixed_base()\n    records = []\n")
        build.write_text(s)
        return
    if not a.link_only:
        return
    build=a.dest/"preview4_whole_build.py"
    s=build.read_text()
    # Do not set global RUSTFLAGS: it invalidates the cached game crates.
    # Run cargo rustc only for the final package, with linker-only flags.
    anchor='    # A report only: the optimization profile, codegen flags, target and ABI'
    idx=s.index(anchor)
    end=s.index('\n\ndef configure(body):',idx)
    s=s[:end]+'''
    apk = ROOT/"packaging/android/build_apk.py"
    # Warm Turbo cache already has --timings. The original cache may be
    # patched above during prepare_fixed_base. Both use this exact anchor.
    fixed_once(apk,
        '"build", BUILD_STD, "--profile", profile, "--timings", *(flag for p in packages for flag in ("-p", p)),',
        '"rustc", BUILD_STD, "--profile", profile, "--timings", *(flag for p in packages for flag in ("-p", p)), "--", "-C", "link-arg=-Wl,--icf=safe", "-C", "link-arg=-Wl,--pack-dyn-relocs=android",')
''' +s[end:]
    build.write_text(s)

if __name__=="__main__":
    main()
