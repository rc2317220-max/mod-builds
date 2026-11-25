#!/usr/bin/env python3
"""Patch only the pinned Preview 4 client to use our fork for Compile v2."""
from pathlib import Path
import sys

p = Path(sys.argv[1]) / "crates/sunrise-client/src/game/starling/native_builds.rs"
s = p.read_text()

def replace_once(old, new):
    global s
    if s.count(old) != 1:
        raise SystemExit(f"Unexpected Preview 4 source: {old[:100]!r}")
    s = s.replace(old, new, 1)

replace_once('    option_env!("SUNRISE_ANDROID_BUILD_COMMIT")\n        .or(option_env!("SUNRISE_GAME_BUILD_ID"))',
             '    option_env!("SUNRISE_GAME_BUILD_ID")\n        .or(option_env!("SUNRISE_ANDROID_BUILD_COMMIT"))')
replace_once('fn compile_from_store(\n    server: &str,',
             'fn compile_from_store(\n    server: &str,\n    repo: &str,')
replace_once('    let repo = store::STORE_REPO;\n    let Some(text) = github_text(',
             '    let Some(text) = github_text(')
replace_once('                agent, server, &build, &missing, &wanted, shared, asked,',
             '                agent, server, repo, &build, &missing, &wanted, shared, asked,')
replace_once('fn build_in_store(\n    agent: &ureq::Agent,\n    server: &str,',
             'fn build_in_store(\n    agent: &ureq::Agent,\n    server: &str,\n    repo: &str,')
replace_once('    let repo = store::STORE_REPO;\n    let tag = store::mods_tag(&build.build);',
             '    let tag = store::mods_tag(&build.build);')
replace_once('        .unwrap_or_else(|| published_server(version));',
             '        .unwrap_or_else(|| "https://rustpg-compile.rustpg-rc2317220.workers.dev".to_owned());')
replace_once('    let body = bundles_body()?;\n    let via',
             '    let via')
replace_once('    if own_service && loads_store_builds() {\n        match compile_from_store(&server, &agent, shared, &mut asked)? {',
             '''    let rustpg_store = server.trim_end_matches('/') == "https://rustpg-compile.rustpg-rc2317220.workers.dev";
    if rustpg_store && !loads_store_builds() {
        return Err("This RustPG Dev APK has no per-mod native loader.".into());
    }
    if rustpg_store || (own_service && loads_store_builds()) {
        let repo = if rustpg_store { "rc2317220-max/mod-builds" } else { store::STORE_REPO };
        match compile_from_store(&server, repo, &agent, shared, &mut asked)? {''')
replace_once('    // The machine that builds sleeps until it is asked:',
             '    let body = bundles_body()?;\n    // The machine that builds sleeps until it is asked:')
p.write_text(s)
print("Preview 4: custom Compile v2 routes both requests and downloads to the RustPG fork")
