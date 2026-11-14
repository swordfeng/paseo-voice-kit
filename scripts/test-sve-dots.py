#!/usr/bin/env python3
"""Check packaged SVE dot-product tails against exact scalar results (no models)."""
import argparse
import ctypes as c
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("library", type=Path)
parser.add_argument("--require-sve", action="store_true")
args = parser.parse_args()
root = args.library.resolve()
libraries = sorted(root.glob("libggml-cpu-arm*.so")) if root.is_dir() else [root]
if not libraries:
    raise SystemExit("No ARM CPU library found")
tested = 0
for path in libraries:
    lib = c.CDLL(str(path))
    if lib.ggml_backend_score() <= 0:
        continue  # Never execute instructions unsupported by this host.
    lib.ggml_cpu_init()
    width = lib.ggml_cpu_get_sve_cnt()
    if not width:
        continue
    checks = 0
    for kind in ("f32", "f16"):
        dot = getattr(lib, "ggml_vec_dot_" + kind)
        dot.argtypes = [c.c_int, c.POINTER(c.c_float), c.c_size_t, c.c_void_p,
                        c.c_size_t, c.c_void_p, c.c_size_t, c.c_int]
        dot.restype = None
        for n in (1, 7, 8, 9, 32, 33, 64, 65, 1496, 1500, 1501):
            # All values are exactly representable, including the scalar result.
            values = (c.c_float * n)(*([1] * n)) if kind == "f32" else (c.c_uint16 * n)(*([0x3c00] * n))
            actual = c.c_float()
            dot(n, c.byref(actual), 0, values, 0, values, 0, 1)
            if actual.value != n:
                raise AssertionError(f"{path.name} {kind} n={n}: expected {n}, got {actual.value}")
            checks += 1
    tested += 1
    print(json.dumps({"library": path.name, "sveBytes": width, "checks": checks}), flush=True)
print(json.dumps({"sveVariantsTested": tested, "skipped": not tested}), flush=True)
if args.require_sve and not tested:
    raise SystemExit("This CI gate requires an SVE-capable runner")
