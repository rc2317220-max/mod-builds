#!/usr/bin/env python3
"""The build's answer, where the Compile service (worker/) and the game read it: the library and its
status in the `results` release as JOB.so and JOB.json, or JOB.failed.json with what went wrong; then
the sealed mods leave the `requests` release.

Runs in build.yml's second job, the one whose token may write releases, on a runner that never ran the
mods: the library is only checked and uploaded, and the status is read as JSON and written again with
the fields the game reads, so nothing the mods made can say more than that.
"""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time

LIBRARY = ("libsunrise_android.so" if os.environ.get("VERSION") == "0.9.0-preview.cac7bf6459" else "libhorizon_android.so")
DID_NOT_FINISH = "The build on GitHub did not finish. Try again."


def answer(result, built):
    """What the run says: ("done", status, library) or ("failed", failure, None)."""
    status = None
    try:
        status = json.loads((result / "status.json").read_text())
    except (OSError, ValueError):
        pass
    if not isinstance(status, dict):
        status = None
    library = result / LIBRARY
    if built and status and status.get("state") == "done" and library.is_file():
        size, want = status.get("size"), status.get("sha256")
        digest = hashlib.sha256()
        with library.open("rb") as f:
            while chunk := f.read(1 << 20):
                digest.update(chunk)
        if library.stat().st_size == size and digest.hexdigest() == want:
            done = {"state": "done", "sha256": want, "size": size, "build": status.get("build")}
            return "done", done, library
        return "failed", failure("The build came out different from what it said.", False), None
    if built and status and status.get("state") == "failed":
        error = str(status.get("error") or "The build failed.")[:600]
        return "failed", failure(error, bool(status.get("settled"))), None
    return "failed", failure(DID_NOT_FINISH, False), None


def failure(error, settled):
    return {"state": "failed", "error": error, "settled": settled, "at": int(time.time())}


def publish(result, job, ask, built, gh, out):
    """Puts the answer up and lets the sealed mods go; `gh` runs the GitHub CLI."""
    if not re.fullmatch(r"[0-9a-f]{24}", job) or not re.fullmatch(r"[0-9a-f]{32}", ask):
        sys.exit(f"Not a request: {job} {ask}")
    out.mkdir(parents=True, exist_ok=True)
    # A release holds 1000 assets at most: the builds are spread over results-0 to results-f by
    # the job's first hex digit (worker/ looks there, then in the old `results`).
    results = f"results-{job[0]}"
    state, status, library = answer(result, built)
    # A fresh fork may not have a result shard yet.
    try:
        gh("release", "view", results)
    except subprocess.CalledProcessError:
        gh("release", "create", results, "--target", "main", "--prerelease", "--title", results, "--notes", "Native build results", check=False)
    if state == "done":
        # The library first: its status is what says it is there.
        so = out / f"{job}.so"
        os.replace(library, so)
        gh("release", "upload", results, str(so), "--clobber")
        (out / f"{job}.json").write_text(json.dumps(status))
        gh("release", "upload", results, str(out / f"{job}.json"), "--clobber")
        gh("release", "delete-asset", results, f"{job}.failed.json", "-y", check=False)
    else:
        (out / f"{job}.failed.json").write_text(json.dumps(status))
        gh("release", "upload", results, str(out / f"{job}.failed.json"), "--clobber")
    gh("release", "delete-asset", "requests", f"{ask}.bin", "-y", check=False)
    print(json.dumps({k: v for k, v in status.items() if k != "build"}))


def run_gh(*args, check=True):
    subprocess.run(["gh", *args], check=check)


if __name__ == "__main__":
    publish(
        pathlib.Path("result"),
        os.environ["JOB"],
        os.environ["ASK"],
        os.environ.get("BUILT") == "success",
        run_gh,
        pathlib.Path("answer"),
    )
