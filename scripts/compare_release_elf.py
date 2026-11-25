#!/usr/bin/env python3
"""Report why a rebuilt library differs from the official APK. Never authorizes a mismatch."""
import hashlib
import json
import pathlib
import struct
import subprocess
import sys

def digest(data):
    return hashlib.sha256(data).hexdigest()

def elf(path):
    data = path.read_bytes()
    if data[:6] != b"\x7fELF\x02\x01":
        raise ValueError(f"not ELF64 little endian: {path.name}")
    header = struct.unpack_from("<16sHHIQQQIHHHHHH", data)
    shoff, shentsize, shnum, shstrndx = header[6], header[11], header[12], header[13]
    entries = [struct.unpack_from("<IIQQQQIIQQ", data, shoff + i * shentsize) for i in range(shnum)]
    st = entries[shstrndx]
    names = data[st[4]:st[4] + st[5]]
    out = {}
    for name, typ, flags, addr, off, size, *_ in entries:
        label = names[name:names.index(b"\x00", name)].decode("ascii", "replace")
        if label:
            out[label] = {"type": typ, "flags": flags, "address": addr, "size": size,
                          "sha256": None if typ == 8 else digest(data[off:off+size])}
    return {"size": len(data), "sha256": digest(data), "sections": out}

def section_bytes(path, section):
    data = path.read_bytes()
    header = struct.unpack_from("<16sHHIQQQIHHHHHH", data)
    shoff, shentsize, shnum, shstrndx = header[6], header[11], header[12], header[13]
    entries = [struct.unpack_from("<IIQQQQIIQQ", data, shoff + i * shentsize) for i in range(shnum)]
    st = entries[shstrndx]
    names = data[st[4]:st[4] + st[5]]
    for name, typ, flags, addr, off, size, *_ in entries:
        if names[name:names.index(b"\x00", name)].decode("ascii", "replace") == section:
            return data[off:off+size] if typ != 8 else b""
    return b""

def diff_bytes(a, b):
    count = abs(len(a)-len(b))
    first = []
    # Skip unchanged blocks to make large text sections inexpensive to inspect.
    for start in range(0, min(len(a),len(b)), 65536):
        x,y = a[start:start+65536],b[start:start+65536]
        if x == y:
            continue
        for i,(u,v) in enumerate(zip(x,y)):
            if u != v:
                count += 1
                if len(first) < 32:
                    first.append({"offset": start+i, "rebuilt": hex(u), "official": hex(v)})
    return {"changed_bytes": count, "first_changes": first}

def exports(nm, path):
    return set(subprocess.check_output([nm, "-D", "--defined-only", "--format=just-symbols", str(path)], text=True).splitlines())

def main():
    built, apk, nm, report = map(pathlib.Path, sys.argv[1:])
    result = {}
    for path in sorted(built.glob("*.so")):
        official = apk / path.name
        if not official.exists():
            result[path.name] = {"missing": True}
            continue
        a, b = elf(path), elf(official)
        if a["sha256"] == b["sha256"]:
            result[path.name] = {"identical": True}
            continue
        diffs = {key: {"rebuilt": a["sections"].get(key), "official": b["sections"].get(key)}
                 for key in sorted(a["sections"].keys() | b["sections"].keys())
                 if a["sections"].get(key) != b["sections"].get(key)}
        for key in diffs:
            diffs[key]["bytes"] = diff_bytes(section_bytes(path,key), section_bytes(official,key))
        ea, eb = exports(str(nm), path), exports(str(nm), official)
        allocated = [k for k,v in diffs.items() if any(x and x["flags"] & 2 for x in (v["rebuilt"], v["official"]))]
        result[path.name] = {"identical": False, "rebuilt_size": a["size"], "official_size": b["size"],
                             "rebuilt_sha256": a["sha256"], "official_sha256": b["sha256"],
                             "allocated_differences": allocated, "sections": diffs,
                             "missing_exports_count": len(eb-ea), "extra_exports_count": len(ea-eb),
                             "missing_exports_sample": sorted(eb-ea)[:20], "extra_exports_sample": sorted(ea-eb)[:20]}
        print(f"{path.name}: differing sections {list(diffs)}; allocated {allocated}; missing exports {len(eb-ea)}; extra exports {len(ea-eb)}")
    report.write_text(json.dumps(result, indent=2) + "\n")

if __name__ == "__main__":
    main()
