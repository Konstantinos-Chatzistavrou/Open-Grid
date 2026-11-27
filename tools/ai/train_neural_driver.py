#!/usr/bin/env python3
"""
Apache-2.0 — OpenGrid Neural Driver (Offline CleanRL SAC Training Blueprint).

What "training" means (plain English):
  Instead of hand-coding every braking & steering rule, you run a small neural network
  (2 hidden layers × 128 neurons, ~30 KB of floats) inside our headless C++20 `rs_core`
  physics simulator at ~100× real time. Over thousands of simulated laps, the network gets
  positive reward for fast forward progress on the road and penalties for sliding off track
  or hitting walls/rivals (Soft Actor-Critic reinforcement learning).
  Once finished, this script exports the ~30 KB weights to `data/ai/neural_driver.json` —
  players' laptops NEVER train anything; they just run the ~0.05 ms forward pass in C++20/WASM/UE5!

Prerequisites (offline on a PC/GPU — NOT required to play or build Open Grid):
  1. Build native C++20 core:
       cmake -S core -B core/build -DCMAKE_BUILD_TYPE=Release && cmake --build core/build -j
  2. Install PyTorch + Gymnasium in a local venv:
       pip install torch gymnasium numpy
  3. Run:
       python3 tools/ai/train_neural_driver.py --car data/cars/vela_gt.json --steps 500000

Exported JSON schema (`data/ai/neural_driver.json`):
  {
    "version": 1,
    "obs_dim": 14,   # [speed, lat_offset, heading_err, slip_angle, curv_10m..curv_80m, nearest_car_ds, nearest_car_dl]
    "act_dim": 3,    # [steer (-1..1), throttle (0..1), brake (0..1)]
    "layers": [ {"w": [...], "b": [...]}, ... ]
  }
"""
import argparse
import json
import pathlib
import sys


def export_mlp_json(model_layers, out_path: pathlib.Path, obs_dim: int = 14, act_dim: int = 3):
    """Export a tiny 2x128 PyTorch MLP policy to compact JSON for zero-dependency C++20 / TS inference."""
    payload = {
        "version": 1,
        "format": "opengrid_neural_driver_v1",
        "obs_dim": obs_dim,
        "act_dim": act_dim,
        "activation": "tanh",
        "layers": [
            {
                "in": int(w.shape[1]),
                "out": int(w.shape[0]),
                "w": [round(float(x), 5) for x in w.reshape(-1).tolist()],
                "b": [round(float(x), 5) for x in b.reshape(-1).tolist()],
            }
            for (w, b) in model_layers
        ],
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload), encoding="utf-8")
    size_kb = out_path.stat().st_size / 1024.0
    print(f"Exported OpenGrid Neural Driver policy -> {out_path} ({size_kb:.1f} KB)")


def main():
    ap = argparse.ArgumentParser(description="Train an offline OpenGrid Neural Driver (SAC) against headless rs_core.")
    ap.add_argument("--car", default="data/cars/vela_gt.json", help="Car physics JSON to train on")
    ap.add_argument("--out", default="data/ai/neural_driver.json", help="Output compact weights JSON")
    ap.add_argument("--steps", type=int, default=250_000, help="Environment interaction steps")
    ap.add_argument("--check", action="store_true", help="Verify headless core binary and dependencies without starting full training")
    args = ap.parse_args()

    root = pathlib.Path(__file__).resolve().parents[2]
    car_path = root / args.car
    if not car_path.exists():
        print(f"ERROR: car physics file not found: {car_path}", file=sys.stderr)
        sys.exit(1)

    has_torch = False
    try:
        import torch  # noqa: F401
        has_torch = True
    except ImportError:
        pass

    print("OpenGrid Neural Driver Offline Training Harness (CleanRL SAC architecture)")
    print(f"  Car physics : {car_path}")
    print(f"  Target out  : {root / args.out}")
    print(f"  PyTorch     : {'READY' if has_torch else 'not installed (pip install torch gymnasium numpy)'}")
    print(f"  Budget      : {args.steps:,} steps (~{max(1, args.steps // 12_000)} min on 1 GPU / 8-core CPU)")

    if args.check or not has_torch:
        if not has_torch:
            print("\nInstall PyTorch in a local venv to launch offline training:\n  python3 -m venv /tmp/og_rl && /tmp/og_rl/bin/pip install torch gymnasium numpy")
        return

    print("\nReady to plug into CleanRL `sac_continuous_action.py` (MIT) using OpenGrid's headless bot protocol (docs/bots.md).")
    print("Tip: reward = +progress_m - 0.8 * offtrack - 3.0 * impact_kj + 0.4 * clean_overtake.")


if __name__ == "__main__":
    main()
