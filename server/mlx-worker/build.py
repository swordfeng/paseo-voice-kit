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
    shutil.copy2(products / "mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib", products / "mlx.metallib")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("--jobs", type=int, default=8)
    build(parser.parse_args())
