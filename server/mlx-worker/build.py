#!/usr/bin/env python3
"""Build the native worker with pinned dependencies and tracked compatibility fixes."""
import argparse
from pathlib import Path
import signal
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parent
REVISION = "209e1cb45498c5b7b4b96d417f9b15fe71d440f5"
# Matches Package.swift (platforms: .macOS(.v14)).
MACOS_MIN = "14.0"


def run(command, deadline, cwd=ROOT):
    process = subprocess.Popen(command, cwd=cwd, start_new_session=True)
    try:
        code = process.wait(timeout=max(0.1, deadline - time.monotonic()))
    except (subprocess.TimeoutExpired, KeyboardInterrupt):
        import os
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        raise
    if code:
        raise subprocess.CalledProcessError(code, command)


def build(args):
    deadline = time.monotonic() + args.timeout
    run(["swift", "package", "--package-path", str(ROOT),
         "--force-resolved-versions", "resolve"], deadline)
    checkout = ROOT / ".build/checkouts/mlx-audio-swift"
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout, timeout=5).decode().strip()
    if revision != REVISION:
        raise RuntimeError("Unexpected upstream revision; review the patch before updating")
    for name in ["respect-requested-token-limit.patch", "read-only-model-loading.patch", "text-token-count.patch"]:
        patch = ROOT / "patches" / name
        applied = subprocess.run(["git", "apply", "--reverse", "--check", str(patch)],
                                 cwd=checkout, capture_output=True, timeout=5).returncode == 0
        if not applied:
            run(["git", "apply", "--check", str(patch)], deadline, checkout)
            run(["git", "apply", str(patch)], deadline, checkout)
    run(["swift", "build", "--package-path", str(ROOT), "--disable-automatic-resolution",
         "-c", "release", "--product", "voicekit-mlx-worker", "-j", str(args.jobs)], deadline)
    products = ROOT / ".build/release"
    compile_metallib(products / "mlx.metallib", deadline)


def compile_metallib(out, deadline):
    """MLX's precompiled Metal kernels, built the way MLX's own CMake builds them.

    `swift build` doesn't compile Metal shaders (mlx-swift's README; Xcode 27's SwiftPM happens
    to, Xcode 26's doesn't), so the library is built here on every toolchain. The rest of MLX's
    kernels are compiled at run time."""
    source = ROOT / ".build/checkouts/mlx-swift/Source/Cmlx/mlx-generated/metal"
    kernels = sorted(source.rglob("*.metal"))
    if not kernels:
        raise RuntimeError("no MLX Metal kernels under " + str(source))
    air = ROOT / ".build/voicekit-metal"
    shutil.rmtree(air, ignore_errors=True)
    air.mkdir(parents=True)
    flags = ["-x", "metal", "-Wall", "-Wextra", "-fno-fast-math", "-Wno-c++17-extensions",
             "-Wno-c++20-extensions", "-Wmetal-addr-spaces", "-mmacosx-version-min=" + MACOS_MIN]
    objects = []
    for kernel in kernels:
        target = air / (kernel.relative_to(source).as_posix().replace("/", "_")[:-len(".metal")] + ".air")
        run(["xcrun", "-sdk", "macosx", "metal", *flags, "-c", str(kernel), "-I" + str(source), "-o", str(target)],
            deadline)
        objects.append(str(target))
    run(["xcrun", "-sdk", "macosx", "metal", *objects, "-o", str(out)], deadline)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("--jobs", type=int, default=8)
    build(parser.parse_args())
