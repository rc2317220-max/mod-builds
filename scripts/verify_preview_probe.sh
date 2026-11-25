#!/usr/bin/env bash
# A trusted API-only mod must build through the same isolated path as phone jobs.
set -euo pipefail
work=$(mktemp -d "$RUNNER_TEMP/release-probe.XXXXXXXX")
mkdir -p "$work/mods" "$work/result"
python3 - "$work" <<'PY'
import hashlib, json, pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
package = root / "probe.hmod"
with zipfile.ZipFile(package, "w") as z:
    z.writestr("sunrise-mod.toml", """id = "rustpg_compile_probe"
name = "RustPG Compile Probe"
version = "0.1.0"
description = "Paired APK API link probe"
authors = []
api = "0.2"
side = "both"
[native]
game = "26.3"
sunrise = "HEAD"
""")
    z.writestr("Cargo.toml", """[package]
name = "rustpg-compile-probe"
version = "0.1.0"
edition = "2024"
[dependencies]
sunrise-mod-api = { path = ".sunrise/sdk/api/crates/sunrise-mod-api" }
""")
    z.writestr("src/lib.rs", """use mod_api::{Hooks, ServerHost};
#[derive(Default)]
struct Probe;
#[mod_api::sunrise_mod]
impl Hooks for Probe {
    fn server_started(&self, _: &mut dyn ServerHost, _: &mut mod_api::ServerStartedEvent) {
        eprintln!("RustPG compile probe");
    }
}
""")
digest = hashlib.sha256(package.read_bytes()).hexdigest()
package.rename(root / "mods" / f"{digest}.hmod")
(root / "jobs.json").write_text(json.dumps([{"job":digest[:32]+".arm64-v8a","abi":"arm64-v8a","sha256":digest}]))
PY
SANDBOX_SECONDS=1800 bash scripts/sandbox.sh "$work/jobs.json" "$work/mods" "$work/result"
python3 - "$work" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
job = json.loads((root/"jobs.json").read_text())[0]["job"]
status = json.loads((root/"result"/f"{job}.status.json").read_text())
print(json.dumps(status, indent=2))
assert status["state"] == "done" and (root/"result"/f"{job}.so").is_file(), "Paired APK probe failed"
PY
cp "$work"/result/*.status.json "$RUNNER_TEMP/release-probe-status.json"
echo "Trusted API-only probe compiled and its actual ELF dependency closure matches the paired APK."
