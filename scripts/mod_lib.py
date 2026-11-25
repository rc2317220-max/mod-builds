#!/usr/bin/env python3
"""Compile v2's build of one mod at a time: each .hmod's library beside a game build's own Cargo build (the base,
scripts/store_base.sh), as the game's loader reads it from its native-libs folder (Starling's android_lib.rs and
horizon-mod-host's native_libraries.rs): `lib<id>.so`, whose `horizon_native_build` says its identity,
"<build> <id> <version> <rustc release>", and a loader refuses a library of another build.

    python3 scripts/mod_lib.py build JOBS MODS RESULT   # BUILD, ABI, PROFILE, MOD_LIB_SOURCE

JOBS is a JSON list of {job, abi, sha256}; each job's .hmod is MODS/<sha256>.hmod. Its answer is
RESULT/<job>.status.json and, when it built, RESULT/<job>.so; scripts/store.py publishes them from a job that runs
nothing of the mods. This runs in the sandbox (scripts/sandbox.sh): no network, no token, nothing kept.

The build is Starling's own, from the base's checkout (MOD_LIB_SOURCE): `tools/android_native_sdk.py mods OUT
X.hmod --profile PROFILE --abi ABI`, with -C prefer-dynamic, so the game's crates are the ones the APK ships and only
the mod compiles. Only a mod that route takes is built: no `[native.*]` tables (mixins, bridges, modules), no build
script, no features, no crate but the mod API, crates of its own inside its package and those the game's Cargo.lock
has (the build has no network). Any other is told to use the whole-game Compile, for good.

The registry's other mods come here too (store.py `plan`), only to be told apart: one with a `mod.wasm` is answered
"doesn't run on Starling", which the game's catalogs read to leave it out; one of content alone is no native mod.
"""
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tomllib
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import store  # noqa: E402
import verify_release_link

# What an unpacked .hmod may be at most, and how many files (a zip bomb stops here).
UNPACKED = 64 << 20
FILES = 4000
# A mod's build, at most.
SECONDS = int(os.environ.get("MOD_LIB_SECONDS", "600"))
# The game's crates a mod may depend on: android_native_sdk.py points this one at the base's checkout.
# Either naming: a game built on Sunrise (Starling since its sync with it) names its crates sunrise-*.
API_PACKAGES = {"horizon-mod-api", "sunrise-mod-api"}
MANIFESTS = ("sunrise-mod.toml", "horizon-mod.toml")
# What a Horizon package names that a Sunrise game has under its own name (sunrise-mod-package's horizon.rs).
RENAMED = re.compile(r"(?<![A-Za-z0-9_])horizon(?=[_-](?:mod|client|core|world|items|protocol|assets|hooks|platform"
                     r"|shader|render|threads|look|optifine|part))")
PIN = re.compile(r"^(\s*)horizon(\s*=)")
# Crates of the game's own lock a mod may also depend on, plainly (a version, no features): the base's Cargo home holds
# them and the game's build made them already, so the sandbox, without a network, compiles only the mod.
GAME_CRATES = {"serde_json", "sha2", "log"}
# A crate Cargo compiled, as its output says it.
COMPILED = re.compile(r"^\s*Compiling (\S+) v", re.M)
# What in a build's output says the mod's own code doesn't compile (for good), not the service.
OWN_ERROR = re.compile(r"error\[E\d{4}\]|could not compile `[hs]mod-")
WHOLE_GAME = "needs the whole-game Compile"
# What the game's catalogs read (Starling's starling_store.rs NOT_ON_STARLING) to leave a mod out.
NOT_ON_STARLING = "doesn't run on Starling"


class Refused(Exception):
    """A mod this route can't build, for good."""


def unpack(hmod, into):
    """The .hmod's files into `into`: plain files and folders inside it, within UNPACKED bytes."""
    with zipfile.ZipFile(hmod) as archive:
        entries = archive.infolist()
        if len(entries) > FILES:
            raise Refused(f"has more than {FILES} files")
        total = 0
        for entry in entries:
            name = entry.filename
            parts = pathlib.PurePosixPath(name).parts
            if not parts or name.startswith("/") or "\\" in name or any(p in ("..", "") for p in parts):
                raise Refused(f"has a file outside itself: {name!r}")
            if stat.S_ISLNK(entry.external_attr >> 16):
                raise Refused(f"has a link: {name}")
            if entry.is_dir():
                (into / name).mkdir(parents=True, exist_ok=True)
                continue
            total += entry.file_size
            if total > UNPACKED:
                raise Refused(f"is more than {UNPACKED >> 20} MB unpacked")
            (into / name).parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, open(into / name, "wb") as target:
                shutil.copyfileobj(source, target, 1 << 20)
            if (into / name).stat().st_size != entry.file_size:
                raise Refused(f"{name}: not the size it says")


def mod_of(folder):
    """The mod's id and version, and its manifest (sunrise-mod.toml, or Horizon's horizon-mod.toml)."""
    try:
        name = next((n for n in MANIFESTS if (folder / n).is_file()), MANIFESTS[0])
        manifest = tomllib.loads((folder / name).read_text())
    except (OSError, ValueError) as e:
        raise Refused(f"is not a mod: {e}")
    mod, version = manifest.get("id"), manifest.get("version")
    if not (isinstance(mod, str) and store.ID.fullmatch(mod)) or not (
        isinstance(version, str) and store.VERSION.fullmatch(version)
    ):
        raise Refused("has no plain id and version")
    return mod, version, manifest


def sunrise_game(source):
    """Whether the base's game is built on Sunrise: its mod API crate has Sunrise's name."""
    return (source / "crates" / "sunrise-mod-api").is_dir()


def apply_port(files, patch):
    """`files` (name -> bytes) with the unified diff `patch` applied, or None when it does not apply exactly:
    another version of the mod, or one its author ported already."""
    out, name, lines, at, delta = dict(files), None, None, 0, 0
    rows = patch.split(b"\n")
    i = 0

    def flush():
        if name is not None and lines is not None:
            out[name] = b"".join(lines)

    while i < len(rows):
        row = rows[i]
        if row.startswith(b"--- "):
            flush()
            old = row[4:].strip().decode("utf-8", "replace")
            fresh = rows[i + 1][4:].strip().decode("utf-8", "replace") if i + 1 < len(rows) else ""
            i += 2
            if fresh == "/dev/null":
                if old[2:] not in out:
                    return None
                del out[old[2:]]
                name, lines = None, None
                continue
            name = fresh[2:]
            if old == "/dev/null":
                lines = []
            elif name in out:
                lines = out[name].splitlines(keepends=True)
            else:
                return None
            # A file with Windows line ends keeps them (a patch made on Windows may have lost the CR).
            eol = b"\r\n" if lines and lines[0].endswith(b"\r\n") else b"\n"
            delta = 0
            continue
        if row.startswith(b"@@ ") and lines is not None:
            try:
                begin = int(row.split(b" ")[1].split(b",")[0][1:])
            except (IndexError, ValueError):
                return None
            at = max(begin - 1, 0) + delta
            i += 1
            while i < len(rows) and rows[i][:1] in (b" ", b"+", b"-", b"\\"):
                kind, body = rows[i][:1], rows[i][1:].rstrip(b"\r") + eol
                if kind == b"\\":
                    # "No newline at end of file": the line before it has none.
                    if rows[i - 1][:1] == b"+" and at > 0:
                        lines[at - 1] = lines[at - 1].rstrip(b"\r\n")
                    i += 1
                    continue
                if kind == b"+":
                    lines.insert(at, body)
                    at += 1
                    delta += 1
                else:
                    if at >= len(lines) or lines[at].rstrip(b"\r\n") != body.rstrip(b"\r\n"):
                        return None
                    if kind == b"-":
                        del lines[at]
                        delta -= 1
                    else:
                        at += 1
                i += 1
            continue
        i += 1
    flush()
    return out


def adopted(hmod, folder, into, mod):
    """The package as a Sunrise game builds it: a Horizon package (`folder`, unpacked) renamed as the game renames
    it when it installs one, and Starling's port of the mod (scripts/ports/<id>.patch: what Sunrise's API changed
    since the mod was written) applied when it applies. The package itself when neither changes it."""
    horizon = (folder / "horizon-mod.toml").is_file() and not (folder / "sunrise-mod.toml").is_file()
    port = pathlib.Path(__file__).resolve().parent / "ports" / f"{mod}.patch"
    if not horizon and not port.is_file():
        return hmod
    files = {}
    with zipfile.ZipFile(hmod) as old:
        for entry in old.infolist():
            if entry.is_dir():
                continue
            name, data = entry.filename, old.read(entry)
            if horizon and name == "horizon-mod.toml":
                native, lines = False, []
                for line in data.decode("utf-8").splitlines(keepends=True):
                    if line.lstrip().startswith("["):
                        native = line.lstrip().startswith("[native]")
                    lines.append(PIN.sub(r"\1sunrise\2", line) if native else line)
                name, data = "sunrise-mod.toml", "".join(lines).encode("utf-8")
            elif horizon and (name == "Cargo.toml" or (name.startswith("src/") and name.endswith(".rs"))):
                try:
                    data = RENAMED.sub("sunrise", data.decode("utf-8")).replace(".horizon/", ".sunrise/").encode("utf-8")
                except UnicodeDecodeError:
                    pass
            files[name] = data
    if port.is_file():
        ported = apply_port(files, port.read_bytes())
        if ported is None:
            print(f"{mod}: Starling's port does not apply to this package; built as it is", flush=True)
        else:
            files = ported
            print(f"{mod}: built with Starling's port", flush=True)
    with zipfile.ZipFile(into, "w", zipfile.ZIP_DEFLATED) as new:
        for name, data in files.items():
            new.writestr(name, data)
    return into


def native_of(folder, manifest):
    """The native mod's Cargo.toml. A wasm mod is told it doesn't run on Starling, for the catalogs to read."""
    if (folder / "mod.wasm").is_file() or isinstance(manifest.get("wasm"), dict):
        raise Refused(f"is a wasm mod: it {NOT_ON_STARLING}")
    if not isinstance(manifest.get("native"), dict):
        raise Refused("is not a native mod")
    try:
        return tomllib.loads((folder / "Cargo.toml").read_text())
    except (OSError, ValueError) as e:
        raise Refused(f"is not a native mod: {e}")


def check(manifest, cargo, folder, known=frozenset(), staged=False):
    """Refused, for good, when this route won't build it. `known`: the crates in the game's Cargo.lock, which the
    build (offline) has. `staged`: the base is the staged game (store_base.sh), whose builds take `[native.*]` rows
    (android_native_sdk.py makes their patch crates)."""
    tables = sorted(k for k, v in (manifest.get("native") or {}).items() if isinstance(v, (list, dict)))
    why = (f"has [native.{', native.'.join(tables)}]" if tables and not staged
           else refusal(cargo, folder, known))
    if why:
        raise Refused(f"{why}: it {WHOLE_GAME}")


def lock_crates(source):
    """The crates the game's Cargo.lock names: the ones a build here has without the network."""
    try:
        lock = tomllib.loads((source / "Cargo.lock").read_text())
    except (OSError, ValueError):
        return frozenset()
    return frozenset(p.get("name") for p in lock.get("package", []) if isinstance(p, dict))


def refusal(cargo, folder, known=frozenset(), root=None):
    """Why the API route won't build this crate, or None (the launcher's `project_refusal`). Starling: besides the
    mod API, a mod may use any crate the game's Cargo.lock has (`known`; the build has no network), and crates of
    its own by a `path` inside its package (`root`), which are held to the same rules but may choose features."""
    own = root is not None
    root = root or folder
    package = cargo.get("package") or {}
    build = package.get("build")
    if (build is not None and build is not False) or (build is None and (folder / "build.rs").is_file()):
        return "has a build script"
    if cargo.get("build-dependencies"):
        return "has build dependencies"
    if cargo.get("features") and not own:
        return "has features"
    for table in dependency_tables(cargo):
        for key, value in table.items():
            krate = value.get("package", key) if isinstance(value, dict) else key
            if krate in API_PACKAGES:
                continue
            if isinstance(value, dict) and "git" in value:
                return f"takes {krate} from git"
            if isinstance(value, dict) and "path" in value:
                path = (folder / value["path"]).resolve()
                if not path.is_relative_to(root.resolve()) or not (path / "Cargo.toml").is_file():
                    return f"takes {krate} from outside its package"
                try:
                    inner = tomllib.loads((path / "Cargo.toml").read_text())
                except (OSError, ValueError) as e:
                    return f"has a crate of its own that won't read ({krate}: {e})"
                if (why := refusal(inner, path, known, root)):
                    return why
                continue
            if krate not in GAME_CRATES and krate not in known:
                return f"uses the crate {krate}, which the game doesn't have"
            if isinstance(value, dict) and set(value) - {"version", "package", "features", "default-features",
                                                          "optional"}:
                return f"takes {krate} from elsewhere than the game's own"
    return None


def dependency_tables(cargo):
    yield cargo.get("dependencies") or {}
    for target in (cargo.get("target") or {}).values():
        if isinstance(target, dict):
            yield target.get("dependencies") or {}


def build_one(row, mods, source, result, build, profile):
    """One job's answer into `result`, built with the base's checkout `source`."""
    job, abi, digest = row["job"], row["abi"], row["sha256"]
    status = {"build": build, "source": digest, "abi": abi}
    work = result / "work" / job
    shutil.rmtree(work, ignore_errors=True)
    folder, out = work / "mod", work / "out"
    folder.mkdir(parents=True)
    try:
        hmod = mods / f"{digest}.hmod"
        if store.job_of(store.sha256_of(hmod), abi) != job:
            raise Refused("is not the file that was asked for")
        try:
            unpack(hmod, folder)
        except zipfile.BadZipFile:
            raise Refused("is not a .hmod")
        mod, version, manifest = mod_of(folder)
        status.update(id=mod, version=version)
        # The port it is built with (scripts/ports), so a new port asks for the build again (store.py).
        if (port := store.port_digest(mod)):
            status["port"] = port
        cargo = native_of(folder, manifest)
        check(manifest, cargo, folder, lock_crates(source),
              (source / "functions.json").is_file() and (source / ".unstaged").is_dir())
        if not sunrise_game(source) and not (folder / "horizon-mod.toml").is_file():
            raise Refused("is made for a newer Starling")
        package = adopted(hmod, folder, work / f"{mod}.smod", mod) if sunrise_game(source) else hmod
        if package != hmod:
            cargo = tomllib.loads(RENAMED.sub("sunrise", (folder / "Cargo.toml").read_text()))
        command = [sys.executable, str(source / "tools" / "android_native_sdk.py"), "mods", str(out), str(package),
                   "--profile", profile, "--abi", abi]
        env = {**os.environ, "RUSTFLAGS": "-C prefer-dynamic", "HORIZON_GAME_BUILD_ID": build,
               "SUNRISE_GAME_BUILD_ID": build}
        if build == "ff303502a4f7982551a0e0d3622d9268efe9e829" and abi == "arm64-v8a":
            # Match the official release build script, which reads git HEAD.
            for key in ("HORIZON_GAME_BUILD_ID", "SUNRISE_GAME_BUILD_ID"):
                env.pop(key, None)
            actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
            if actual != build:
                raise ValueError("base checkout has the wrong git identity")
        if (source / "functions.json").is_file() and (source / ".unstaged").is_dir():
            # A staged base (store_base.sh): mods with [native.*] rows build their patch crates.
            env.update(SUNRISE_UNSTAGED_SOURCE=str(source / ".unstaged"),
                       SUNRISE_ANDROID_PATCH=str(source / "target/host-tools/release/sunrise-android-patch"),
                       SUNRISE_ANDROID_PATCH_HOME=str(source / ".android-patch-home"))
        try:
            done = subprocess.run(command, cwd=source, env=env, capture_output=True, text=True, timeout=SECONDS)
        except subprocess.TimeoutExpired:
            return said(result, job, {**status, "state": "failed", "error": "The build took too long.", "settled": False})
        if done.returncode != 0:
            said_by = done.stdout + "\n" + done.stderr
            print(said_by[-4000:], flush=True)
            # Cargo's own error lines first: the game shows the answer's first line, and the end of the output
            # is Python's traceback around the failed command (a phone showed ")))", 2026-11-20).
            errors = [line for line in said_by.splitlines() if line.startswith("error")]
            error = "\n".join(errors[:6])[:600] if errors else \
                (done.stderr or done.stdout or "The build failed.").strip()[-600:]
            return said(result, job, {**status, "state": "failed", "error": error,
                                      "settled": bool(OWN_ERROR.search(said_by))})
        # Only the mod compiles beside the base. A crate of the game's that compiled again (a feature the mod's
        # dependencies turned on, say) is one the APK doesn't have, and the library would not open on a phone.
        again = sorted(set(COMPILED.findall(done.stdout + "\n" + done.stderr)) - {f"hmod-{mod}", f"smod-{mod}"})
        if again:
            # Said, not refused: a build asked for by a phone (mod.yml) compiles android-activity, cpal, horizon-android
            # and horizon-client again every time, and its library opens on the phone all the same. Refusing it made
            # players ask again for ever, ten minutes each (2026-11-22).
            print(f"{job}: the game's crates built again beside {mod}: {', '.join(again[:6])}", flush=True)
        record = json.loads((out / "native-mods.json").read_text())
        made = next((r for r in record.get("libraries", []) if isinstance(r, dict) and r.get("mod") == mod), None)
        if made is None:
            raise ValueError(f"the build made no library of {mod}")
        name, identity = made.get("file"), made.get("identity")
        if not (isinstance(name, str) and store.LIBRARY.fullmatch(name) and (out / name).is_file()):
            raise ValueError(f"the build named no plain library: {name!r}")
        words = str(identity).split(" ")
        # Four words on Starling's Horizon-based game (0.9.0); five on the Sunrise-based one, whose loader also
        # wants the panic strategy (`<build> <mod> <version> <rustc> unwind`).
        if not (len(words) == 4 or (len(words) == 5 and words[4] == "unwind")) or words[:3] != [build, mod, version]:
            raise ValueError(f"the library's identity {identity!r} is not {build[:12]} {mod} {version}")
        paired = os.environ.get("RUSTPG_PAIRED_APK") == "1"
        if paired or (build == verify_release_link.BUILD and abi == verify_release_link.ABI):
            try:
                reference = pathlib.Path(os.environ["RUSTPG_APK_REFERENCE"])
                if paired and (reference / "paired-build-id").read_text().strip() != build:
                    raise ValueError("paired APK build identity mismatch")
                verify_release_link.verify(source, out / name, profile, reference, paired=paired)
            except (OSError, ValueError, subprocess.CalledProcessError) as e:
                raise ValueError(f"official APK link verification failed: {e}") from e
        library = result / f"{job}.so"
        shutil.copyfile(out / name, library)
        if store.sha256_of(library) != made.get("sha256"):
            raise ValueError("the library is not the one its record says")
        return said(result, job, {**status, "state": "done", "library": name, "identity": identity,
                                  "sha256": store.sha256_of(library), "size": library.stat().st_size})
    except Refused as e:
        return said(result, job, {**status, "state": "failed", "error": f"This mod {e}.", "settled": True})
    except (OSError, ValueError) as e:
        return said(result, job, {**status, "state": "failed", "error": f"The build went wrong: {e}", "settled": False})
    finally:
        shutil.rmtree(work, ignore_errors=True)


def said(result, job, status):
    (result / f"{job}.status.json").write_text(json.dumps(status))
    print(f"{job}: {status.get('id', '?')} {status['state']}"
          + (f": {status['error']}" if status["state"] == "failed" else ""), flush=True)
    return status


def main(argv):
    if len(argv) != 5 or argv[1] != "build":
        sys.exit(__doc__)
    build = os.environ.get("BUILD", "")
    if not store.BUILD.fullmatch(build):
        sys.exit(f"Not a build: {build!r}")
    source = pathlib.Path(os.environ["MOD_LIB_SOURCE"])
    profile = os.environ.get("PROFILE", "fast")
    jobs = json.loads(pathlib.Path(argv[2]).read_text())
    mods, result = pathlib.Path(argv[3]), pathlib.Path(argv[4])
    result.mkdir(parents=True, exist_ok=True)
    for row in jobs:
        if not (store.JOB.fullmatch(str(row.get("job"))) and store.SHA256.fullmatch(str(row.get("sha256")))):
            continue
        build_one(row, mods, source, result, build, profile)
    shutil.rmtree(result / "work", ignore_errors=True)


if __name__ == "__main__":
    main(sys.argv)
