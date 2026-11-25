#!/usr/bin/env python3
"""Preview 4's original custom-server protocol returns ONE monolithic game .so.
Only API-native .smod packages are accepted for now; no source code runs outside
the isolated compilation sandbox. No APK or signing key is required.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mod_lib

COMMIT = "cac7bf64590fb38b4badee90f1f09848ce7f8daa"
VERSION = "0.9.0-preview.cac7bf6459"
ABI = "arm64-v8a"
ROOT = Path.home() / "store/source"
MAX_BODY = 32 << 20
MAX_EXPANDED = 128 << 20
MAX_MODS = 32
ID = re.compile(r"[a-z][a-z0-9_]{0,63}")
SIDE = {"both":"Both","client":"Client","server":"Server"}

def replace_once(path, old, new):
    s = path.read_text()
    if s.count(old) != 1:
        raise RuntimeError(f"pinned source anchor changed: {path.name}: {old[:80]}")
    path.write_text(s.replace(old, new, 1))

def frame(body):
    if not body or len(body) > MAX_BODY:
        raise mod_lib.Refused("request size is invalid")
    at = 0
    count = 0
    total = 0
    while at < len(body):
        if at + 4 > len(body):
            raise mod_lib.Refused("truncated mod request")
        size = int.from_bytes(body[at:at+4], "big")
        at += 4
        if size == 0 or at + size > len(body):
            raise mod_lib.Refused("truncated mod archive")
        raw = body[at:at+size]
        at += size
        count += 1
        if count > MAX_MODS:
            raise mod_lib.Refused("too many mods in one request")
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            total += sum(x.file_size for x in z.infolist())
            if total > MAX_EXPANDED:
                raise mod_lib.Refused("expanded request exceeds 128 MiB")
            names = [x.filename for x in z.infolist() if not x.is_dir()]
            if len(names) != len(set(names)):
                raise mod_lib.Refused("duplicate archive paths")
        yield raw

def fingerprint(folder):
    h = hashlib.sha256()
    files = sorted(p for p in folder.rglob("*") if p.is_file())
    for p in files:
        rel = p.relative_to(folder).as_posix()
        if rel.startswith(("assets/","data/")):
            continue
        name = rel.encode()
        data = p.read_bytes()
        h.update(len(name).to_bytes(8,"big")); h.update(name)
        h.update(len(data).to_bytes(8,"big")); h.update(data)
    return h.hexdigest()

RUNTIME = """
    /// The original Android v1 client keeps the validated .smod files in its
    /// instance. Match their exact code bytes to the whole-game build.
    pub fn load_phone(
        root: &Path, built: &'static [BuiltMod], hashes: &[&str],
    ) -> Result<Self, String> {
        use sha2::{Digest, Sha256};
        if hashes.len() != built.len() {
            return Err("compiled inventory is inconsistent".into());
        }
        let folder = root.join(NATIVE_DIR);
        let mut candidates: Vec<_> = std::fs::read_dir(&folder)
            .map_err(|e| format!("{}: {e}", folder.display()))?
            .filter_map(Result::ok).map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "smod")).collect();
        candidates.sort();
        let mut selected = Vec::with_capacity(built.len());
        for (expected, want) in built.iter().zip(hashes) {
            let mut found = None;
            for path in &candidates {
                let Ok(bundle) = crate::index::native::Bundle::read(path) else { continue; };
                let m = &bundle.manifest;
                if m.id != expected.id ||
                   crate::manifest::parse_version(expected.version).as_ref() != Ok(&m.version) ||
                   m.side != expected.side { continue; }
                let mut sha = Sha256::new();
                for (name, bytes) in &bundle.files {
                    if name.starts_with("assets/") || name.starts_with("data/") { continue; }
                    sha.update((name.len() as u64).to_be_bytes());
                    sha.update(name.as_bytes());
                    sha.update((bytes.len() as u64).to_be_bytes());
                    sha.update(bytes);
                }
                if format!("{:x}", sha.finalize()) != *want { continue; }
                found = Some(packages::read_native(path).map_err(|e| e.to_string())?);
                break;
            }
            selected.push(found.ok_or_else(|| format!(
                "Compiled mod {} changed or is missing; compile again.", expected.id
            ))?);
        }
        Ok(Self { built, packages: selected })
    }
"""

def configure(body):
    sys.path.insert(0, str(ROOT / "tools"))
    import android_native_sdk as sdk
    folder = ROOT / "rustpg-whole-mods"
    folder.mkdir(exist_ok=True)
    replace_once(ROOT/"Cargo.toml", "members = [\n",
                 'members = [\n    "rustpg-whole-mods/*",\n')
    runtime = ROOT/"crates/sunrise-mod-package/src/runtime.rs"
    replace_once(runtime, "impl Runtime {\n", "impl Runtime {\n" + RUNTIME)
    android = ROOT/"crates/sunrise-client/src/android_lib.rs"
    replace_once(android, "use winit::platform::android::activity::AndroidApp;",
                 "use winit::platform::android::activity::AndroidApp;\nmod rustpg_whole;")
    replace_once(android, "let (entries, native) = native_libraries();",
                 """let (entries, native) = match rustpg_whole::load(&startup.launch().context.game_dir) {
        Ok(loaded) => loaded,
        Err(error) => {
            sunrise_client::android::warn(&error);
            Default::default()
        }
    };""")
    cargo_android = ROOT/"crates/sunrise-android/Cargo.toml"
    dependency_lines = []
    entries = []
    built = []
    hashes = []
    records = []
    seen = set()
    with tempfile.TemporaryDirectory() as tmp:
        for i, raw in enumerate(frame(body)):
            archive = Path(tmp)/f"{i}.smod"
            archive.write_bytes(raw)
            package = Path(tmp)/f"pkg{i}"
            package.mkdir()
            mod_lib.unpack(archive, package)
            if not (package/"sunrise-mod.toml").is_file():
                raise mod_lib.Refused("requires a Sunrise .smod manifest, not an old Horizon bundle")
            mod, version, manifest = mod_lib.mod_of(package)
            if not ID.fullmatch(mod) or mod in seen:
                raise mod_lib.Refused("duplicate or unsupported native id")
            seen.add(mod)
            side = manifest.get("side", "both")
            if side not in SIDE:
                raise mod_lib.Refused("unsupported mod side")
            cargo = mod_lib.native_of(package, manifest)
            mod_lib.check(manifest, cargo, package, mod_lib.lock_crates(ROOT), staged=False)
            # These inputs are untrusted. Their code is only ever compiled in
            # this offline, privilege-stripped sandbox.
            hashes.append(json.dumps(fingerprint(package)))
            work = folder/mod
            shutil.move(package, work)
            sdk.own_crates(work, cargo)
            cargo_text = sdk.package_manifest(mod, version, cargo, work).replace(
                'crate-type = ["dylib"]', 'crate-type = ["rlib"]')
            (work/"Cargo.toml").write_text(cargo_text)
            hook = sdk.hooks_path(work/"src")
            with (work/"src/lib.rs").open("a") as f:
                f.write("\npub fn rustpg_whole_hooks() -> Box<dyn mod_api::Hooks> { " + hook + "() }\n")
            dep = f"rustpg_whole_{mod}"
            dependency_lines.append(f'{dep} = {{ package = "smod-{mod}", path = "../../rustpg-whole-mods/{mod}" }}')
            entries.append(f'mod_platform::ModEntry::new({json.dumps(mod)}, {dep}::rustpg_whole_hooks()),')
            built.append(f'mod_platform::__private::native::BuiltMod {{ id: {json.dumps(mod)}, version: {json.dumps(version)}, side: mod_platform::Side::{SIDE[side]} }},')
            records.append({"id":mod,"version":version})
    replace_once(cargo_android, "# The NativeActivity glue", "\n".join(dependency_lines) + "\n# The NativeActivity glue")
    generated = """
use std::path::Path;
use mod_platform::{ModEntry, __private::native::BuiltMod};
use sunrise_mod_package::runtime::Runtime;
static BUILT: &[BuiltMod] = &[
""" + "\n".join(built) + """
];
static HASHES: &[&str] = &[
""" + ",\n".join(hashes) + """
];
pub fn load(root: &Path) -> Result<(Vec<ModEntry>, Runtime), String> {
    let native = Runtime::load_phone(root, BUILT, HASHES)?;
    let entries = vec![
""" + "\n".join(entries) + """
    ];
    sunrise_client::android::set_native_libs_opened(BUILT.iter().map(|m| m.id).collect());
    Ok((entries, native))
}
"""
    (android.parent/"rustpg_whole.rs").write_text(generated)
    return records

def compile_game(body, out):
    if subprocess.check_output(["git","rev-parse","HEAD"], cwd=ROOT, text=True).strip() != COMMIT:
        raise RuntimeError("wrong original Preview 4 checkout")
    records = configure(body)
    env = dict(os.environ)
    env.pop("RUSTFLAGS", None)
    env["SUNRISE_GAME_BUILD_ID"] = COMMIT
    env["CARGO_NET_OFFLINE"] = "true"
    # The original launcher selects one replacement JNI library from its
    # private folder. A static build must NOT link the APK's Rust dylibs.
    command = [sys.executable, "packaging/android/build_apk.py", "--abi", ABI,
               "--profile", "fast", "--library-only"]
    result = subprocess.run(command, cwd=ROOT, env=env)
    if result.returncode:
        return {"state":"failed","error":"Native source compilation failed; see the GitHub build log.","settled":False}
    made = ROOT/"target/android/libsunrise_android.so"
    ndk = Path(os.environ["ANDROID_NDK_HOME"])/"toolchains/llvm/prebuilt/linux-x86_64/bin"
    readelf = str(ndk/"llvm-readelf")
    header = subprocess.check_output([readelf,"-h",made], text=True)
    dynamic = subprocess.check_output([readelf,"-d",made], text=True)
    exports = subprocess.check_output([str(ndk/"llvm-nm"),"-D","--defined-only","--format=just-symbols",made], text=True)
    if not re.search(r"Machine:\s+AArch64",header) or "starling_on_create" not in exports.splitlines():
        raise RuntimeError("not an Android ARM64 NativeActivity library")
    needed = re.findall(r"Shared library: \[([^\]]+)\]",dynamic)
    if any(n.startswith(("libsunrise_","libhorizon_","libmod_","libstd-","libemutls")) for n in needed):
        raise RuntimeError(f"whole-game library unexpectedly links game Rust dylibs: {needed}")
    path = out/made.name
    shutil.copyfile(made,path)
    digest = hashlib.file_digest(path.open("rb"),"sha256").hexdigest()
    size = path.stat().st_size
    about = {"version":VERSION,"commit":COMMIT,"profile":"fast","abi":ABI,"mods":records,
             "permissions":[],"sha256":digest,"size":size}
    print("Preview 4 standalone ARM64 JNI library; dependencies:", needed, flush=True)
    return {"state":"done","sha256":digest,"size":size,"build":about}

def main():
    out = Path(sys.argv[2])
    out.mkdir(parents=True,exist_ok=True)
    try:
        answer = compile_game(Path(sys.argv[1]).read_bytes(),out)
    except (mod_lib.Refused,zipfile.BadZipFile) as exc:
        answer = {"state":"failed","error":str(exc)[:600],"settled":True}
    except (OSError,RuntimeError,ValueError,subprocess.CalledProcessError) as exc:
        answer = {"state":"failed","error":str(exc)[:600],"settled":False}
    (out/"status.json").write_text(json.dumps(answer))
    print(json.dumps(answer),flush=True)

if __name__ == "__main__":
    main()
