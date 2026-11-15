#!/usr/bin/env python3
"""Build and stage the self-contained Apple Silicon MLX helper for native packages."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "server/mlx-worker"


def output(*args):
    return subprocess.check_output(args, text=True, timeout=30)


def dependencies(path):
    return [line.strip().split(" (", 1)[0] for line in
            output("otool", "-arch", "arm64", "-L", str(path)).splitlines() if line.startswith("\t")]


def rpaths(path):
    return re.findall(r"cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset", output("otool", "-l", str(path)))


def bundle_libraries(stage, products):
    queue = [stage / "voicekit-mlx-worker"]
    paths = rpaths(queue[0])
    for binary in queue:
        for dependency in dependencies(binary):
            if dependency.startswith(("/System/Library/", "/usr/lib/")):
                continue
            name = Path(dependency).name
            if ".framework/" in dependency:
                raise RuntimeError("Unexpected non-system framework: " + dependency)
            target = stage / name
            if target != binary and not target.exists():
                if dependency.startswith("@rpath/"):
                    candidates = [products / name] + [Path(p) / name for p in paths if not p.startswith("@")]
                elif dependency.startswith("@loader_path/"):
                    candidates = [products / name]
                else:
                    candidates = [Path(dependency)]
                source = next((p for p in candidates if p.is_file()), None)
                if source is None:
                    raise RuntimeError("Cannot bundle dependency: " + dependency)
                arches = output("lipo", "-archs", str(source)).split()
                if "arm64" not in arches:
                    raise RuntimeError("Non-arm64 dependency: " + str(source))
                if len(arches) > 1:
                    subprocess.check_call(["lipo", str(source), "-thin", "arm64", "-output", str(target)])
                else:
                    shutil.copy2(source, target)
                target.chmod(0o755)
                queue.append(target)
            if target != binary:
                subprocess.check_call(["install_name_tool", "-change", dependency, "@loader_path/" + name, str(binary)])
        for path in rpaths(binary):
            if path.startswith("/") and path != "/usr/lib/swift":
                subprocess.check_call(["install_name_tool", "-delete_rpath", path, str(binary)])
    for binary in reversed(queue):
        subprocess.check_call(["codesign", "--force", "--sign", "-", str(binary)])
        for dependency in dependencies(binary):
            if not dependency.startswith(("/System/Library/", "/usr/lib/", "@loader_path/")):
                raise RuntimeError("Unbundled dependency: " + dependency)


def notices(stage):
    destination = stage / "notices"
    destination.mkdir()
    lock = json.loads((PACKAGE / "Package.resolved").read_text())
    shutil.copy2(PACKAGE / "Package.resolved", destination)
    shutil.copytree(PACKAGE / "patches", destination / "patches")
    shutil.copy2(ROOT / "LICENSE", destination / "VOICEKIT-LICENSE")
    shutil.copy2(ROOT / "licenses/Swift-Apache-2.0-with-runtime-exception.txt", destination)
    checkouts = PACKAGE / ".build/checkouts"
    rows = []
    for pin in lock["pins"]:
        source = next(p for p in checkouts.iterdir() if p.name.lower() == pin["identity"].lower())
        count = 0
        for folder, dirs, files in os.walk(source):
            dirs[:] = [d for d in dirs if d not in (".git", ".build", "node_modules")]
            for name in files:
                if not name.upper().startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE", "AUTHORS")):
                    continue
                path = Path(folder) / name
                if not path.is_file() or path.is_symlink():
                    continue
                target = destination / pin["identity"] / path.relative_to(source)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
                count += 1
        if not count:
            raise RuntimeError("Missing upstream license notices: " + pin["identity"])
        state = pin["state"]
        rows.append(f'| {pin["identity"]} | {state.get("version", state["revision"])} | {pin["location"]} |')
    (destination / "DEPENDENCIES.md").write_text(
        "# Native MLX helper dependencies\n\nOriginal notices include nested bundled dependencies. "
        "The Swift compatibility library is redistributed from the build toolchain; its license is included.\n\n"
        "Voice Kit patches the Qwen token budget and makes model/tokenizer loading read-only; patches are included.\n\n"
        "| Package | Version / revision | Source |\n| --- | --- | --- |\n" + "\n".join(rows) + "\n")


def main(args):
    if sys.platform != "darwin" or os.uname().machine != "arm64":
        raise SystemExit("The bundled MLX worker is built only on Apple Silicon")
    if not args.skip_build:
        subprocess.check_call([sys.executable, str(PACKAGE / "build.py"), "--timeout", str(args.timeout)])
    products = PACKAGE / ".build/release"
    target = args.target_dir.resolve()
    target.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".mlx-runtime-", dir=target))
    shutil.copy2(products / "voicekit-mlx-worker", stage)
    if output("lipo", "-archs", str(stage / "voicekit-mlx-worker")).split() != ["arm64"]:
        raise RuntimeError("The native MLX worker must be arm64")
    shutil.copy2(products / "mlx.metallib", stage)
    for resource in products.glob("*.bundle"):
        shutil.copytree(resource, stage / resource.name)
    bundle_libraries(stage, products)
    files = sorted(str(p.relative_to(stage)) for p in stage.rglob("*") if p.is_file())
    manifest = {"backend": "swift-mlx", "protocol": 1, "architecture": "arm64", "minimumMacOS": "14.0", "files": files}
    (stage / "runtime.json").write_text(json.dumps(manifest, indent=2) + "\n")
    notices(stage)
    final = target / "mlx-runtime"
    if final.exists():
        final.rename(target / (".mlx-runtime.previous-" + uuid.uuid4().hex))
    stage.rename(final)
    print(final)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-dir", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=600)
    parser.add_argument("--skip-build", action="store_true")
    main(parser.parse_args())
