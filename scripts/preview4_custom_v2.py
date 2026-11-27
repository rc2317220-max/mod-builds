#!/usr/bin/env python3
"""Apply narrowly scoped custom v2 routing to the pinned Preview 4 checkout.
This does not convert a static APK into a dynamic APK. Run SDK prepare and
build with prefer-dynamic for the client that will use these libraries.
"""
from pathlib import Path
import subprocess
import sys

PIN = "cac7bf64590fb38b4badee90f1f09848ce7f8daa"

def patch(root):
    assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip() == PIN
    path = root / "crates/sunrise-client/src/game/starling/native_builds.rs"
    source = path.read_text()
    def once(old, new):
        nonlocal source
        assert source.count(old) == 1, f"changed source anchor: {old[:100]}"
        source = source.replace(old, new, 1)
    # V1 is ARM64-only. Expose the compilation UI on x86_64 only on a
    # dynamic installation, which will use the per-mod route exclusively.
    once('const SERVICE_SUPPORTED: bool = cfg!(target_arch = "aarch64");', '''fn service_supported() -> bool {
    cfg!(target_arch = "aarch64") || (cfg!(target_arch = "x86_64") && loads_store_builds())
}''')
    assert source.count("SERVICE_SUPPORTED") == 6, "changed architecture guard"
    source = source.replace("SERVICE_SUPPORTED", "service_supported()")
    # Only explicit engine modifications require rebuilding game code.
    # Reject these before contacting the v2 store; never interpret ordinary
    # Cargo errors or unsupported dependencies as permission to rebuild.
    once("    let StoreWanted { mods: wanted, old } = store_wanted()?;", '''    let StoreWanted { mods: wanted, old } = store_wanted()?;
    let mut engine_mods = Vec::new();
    for (path, w) in &wanted {
        let bundle = sunrise_mod_package::index::native::Bundle::read(path)
            .map_err(|e| format!("{}: {e}", w.id))?;
        if let Some(native) = &bundle.manifest.native {
            if !native.mixin.is_empty() || !native.module.is_empty()
                || !native.bridge.is_empty() || !native.state.is_empty()
                || !native.r#loop.is_empty()
            {
                engine_mods.push(w.id.clone());
            }
        }
    }
    if !engine_mods.is_empty() {
        return Ok(FromStore::NotHere(format!(
            "{} require engine patches. This dynamic installation cannot apply those patches yet. Disable them to compile API-only mods.",
            engine_mods.join(", ")
        )));
    }''')
    once("fn compile_from_store(\n    server: &str,", "fn compile_from_store(\n    server: &str,\n    repo: &str,")
    once('    say("Looking for your mods in the store...".into());\n    let repo = store::STORE_REPO;', '    say("Looking for your mods in the store...".into());')
    once("agent, server, &build, &missing, &wanted, shared, asked,", "agent, server, repo, &build, &missing, &wanted, shared, asked,")
    once("fn build_in_store(\n    agent: &ureq::Agent,\n    server: &str,", "fn build_in_store(\n    agent: &ureq::Agent,\n    server: &str,\n    repo: &str,")
    once("    let repo = store::STORE_REPO;\n    let tag = store::mods_tag(&build.build);", "    let tag = store::mods_tag(&build.build);")
    once('        if answer["job"].as_str() != Some(job.as_str()) {', '''        if answer["repo"].as_str() != Some(repo) || answer["tag"].as_str() != Some(tag.as_str()) {
            return Err("The custom build server answered for another store.".into());
        }
        if answer["job"].as_str() != Some(job.as_str()) {''')
    once("    let body = bundles_body()?;\n    let via", "    let via")
    once('''    if own_service && loads_store_builds() {
        match compile_from_store(&server, &agent, shared, &mut asked)? {''', '''    if loads_store_builds() {
        // A dynamic installation can load small mod libraries. Never silently
        // download an entire static engine on a v2 build error.
        let repo = if own_service {
            store::STORE_REPO.to_owned()
        } else {
            let info: serde_json::Value = agent
                .get(&format!("{server}/v2/capabilities"))
                .call()
                .map_err(service_error)?
                .into_json()
                .map_err(|e| e.to_string())?;
            if info["schema"].as_u64() != Some(1)
                || !info["protocols"].as_array().is_some_and(|p| p.iter().any(|v| v.as_str() == Some("v2")))
            {
                return Err("This custom server does not advertise Compile v2.".into());
            }
            info["repo"].as_str().and_then(store::plain_repo)
                .ok_or("The custom server did not identify a valid mod store.")?.to_owned()
        };
        match compile_from_store(&server, &repo, &agent, shared, &mut asked)? {''')
    once("    // The machine that builds sleeps until it is asked:", "    let body = bundles_body()?;\n    // The machine that builds sleeps until it is asked:")
    once("let how = if custom_host.is_none() && loads_store_builds() {", "let how = if loads_store_builds() {")
    path.write_text(source)

if __name__ == "__main__":
    patch(Path(sys.argv[1]).resolve())
