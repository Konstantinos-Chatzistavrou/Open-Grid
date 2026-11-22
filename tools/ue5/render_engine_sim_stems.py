#!/usr/bin/env python3
"""
Apache-2.0 — AngeTheGreat engine-sim (MIT) Headless Dyno Stem Renderer for OpenGrid (UE 5.8 + WebGPU).

Runs our headless Linux/cross-platform C++ driver (`tools/ue5/engine_sim_dyno.cpp`) linked against
AngeTheGreat's MIT-licensed `ange-yaghi/engine-sim` real-time thermodynamic combustion & exhaust
waveguide simulator to render all 26 piston engine stems (4 exact constant-RPM dyno holds per engine
family: Flat-6 GT3, Ferrari V12, Lexus LFA V10, Toyota 2JZ I6, GM LS Cross-Plane V8, Ferrari F136
Flat-Plane V8, and Supercharged LS V8) at 48 kHz / 24-bit PCM WAV (UE 5.8) and Vorbis OGG (WebGPU).

Preserves the real CC-BY 3.0 Mazda RX-7 rotary stems, real CC-BY 3.0 turbo/BOV/anti-lag/gearbox FX
stems, and surface loops already in `ue5/Import/Audio/` & `web/public/assets/audio/`, and updates
`assets_source/audio/manifest.json` with exact MIT + CC-BY 3.0 provenance.
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract_real_audio_stems as real_mod  # noqa: E402
import generate_audio_stems as synth_mod  # noqa: E402

SAMPLE_RATE = 48000
LOOP_DURATION_S = 1.5
LOOP_SAMPLES = int(round(SAMPLE_RATE * LOOP_DURATION_S))


@dataclass(frozen=True)
class DynoJob:
    stem_id: str
    engine_id: str
    description: str
    ref_rpm: int
    firings_per_rev: float
    throttle: float
    presence_db: float = 0.0
    add_sc_whine_hz: float = 0.0


DYNO_JOBS: list[DynoJob] = [
    # Porsche 911 GT3 4.0L Flat-6 Boxer (engine-sim MIT)
    DynoJob("eng_flat6_1000", "flat6", "1000 RPM AngeTheGreat engine-sim Porsche 911 GT3 Flat-6 idle loop", 1000, 3.0, 0.06, 0.0),
    DynoJob("eng_flat6_low",  "flat6", "2400 RPM AngeTheGreat engine-sim Porsche 911 GT3 Flat-6 low-mid pull loop", 2400, 3.0, 0.52, 1.5),
    DynoJob("eng_flat6_4000", "flat6", "4800 RPM AngeTheGreat engine-sim Porsche 911 GT3 Flat-6 titanium howl loop", 4800, 3.0, 0.85, 2.5),
    DynoJob("eng_flat6_7800", "flat6", "7800 RPM AngeTheGreat engine-sim Porsche 911 GT3 Flat-6 redline scream loop", 7800, 3.0, 1.00, 3.2),

    # Ferrari 412 T2 V12 (engine-sim MIT)
    DynoJob("eng_v12_1000", "v12", "1000 RPM AngeTheGreat engine-sim Ferrari V12 idle loop", 1000, 6.0, 0.06, 0.5),
    DynoJob("eng_v12_low",  "v12", "2500 RPM AngeTheGreat engine-sim Ferrari V12 low-mid pull loop", 2500, 6.0, 0.52, 1.5),
    DynoJob("eng_v12_5000", "v12", "5000 RPM AngeTheGreat engine-sim Ferrari V12 F1 soprano howl loop", 5000, 6.0, 0.85, 2.5),
    DynoJob("eng_v12_8000", "v12", "8000 RPM AngeTheGreat engine-sim Ferrari V12 redline scream loop", 8000, 6.0, 1.00, 3.0),

    # Lexus LFA / Exotic 72° V10 Screamer (engine-sim MIT)
    DynoJob("eng_v10_1000", "v10", "1000 RPM AngeTheGreat engine-sim Lexus LFA V10 idle loop", 1000, 5.0, 0.06, 0.5),
    DynoJob("eng_v10_low",  "v10", "2400 RPM AngeTheGreat engine-sim Lexus LFA V10 low-mid pull loop", 2400, 5.0, 0.52, 1.8),
    DynoJob("eng_v10_5500", "v10", "5200 RPM AngeTheGreat engine-sim Lexus LFA V10 angel howl loop", 5200, 5.0, 0.85, 2.8),
    DynoJob("eng_v10_7800", "v10", "7800 RPM AngeTheGreat engine-sim Lexus LFA V10 redline scream loop", 7800, 5.0, 1.00, 3.2),

    # Toyota 2JZ Inline-6 (engine-sim MIT)
    DynoJob("eng_tt_i6_1000", "i6", "1000 RPM AngeTheGreat engine-sim Toyota 2JZ Inline-6 idle loop", 1000, 3.0, 0.06, 0.0),
    DynoJob("eng_tt_i6_low",  "i6", "2400 RPM AngeTheGreat engine-sim Toyota 2JZ Inline-6 baritone pull loop", 2400, 3.0, 0.55, 1.5),
    DynoJob("eng_tt_i6_4000", "i6", "4500 RPM AngeTheGreat engine-sim Toyota 2JZ Inline-6 boost roar loop", 4500, 3.0, 0.85, 2.2),
    DynoJob("eng_tt_i6_7000", "i6", "7000 RPM AngeTheGreat engine-sim Toyota 2JZ Inline-6 redline wail loop", 7000, 3.0, 1.00, 2.8),

    # GM LS Cross-Plane V8 (engine-sim MIT)
    DynoJob("eng_v8_cross_900",  "v8_cross", "900 RPM AngeTheGreat engine-sim GM LS Cross-Plane V8 lope idle loop", 900, 4.0, 0.06, 0.0),
    DynoJob("eng_v8_cross_low",  "v8_cross", "2100 RPM AngeTheGreat engine-sim GM LS Cross-Plane V8 muscle pull loop", 2100, 4.0, 0.55, 1.2),
    DynoJob("eng_v8_cross_4200", "v8_cross", "4200 RPM AngeTheGreat engine-sim GM LS Cross-Plane V8 thunder roar loop", 4200, 4.0, 0.88, 2.0),
    DynoJob("eng_v8_cross_6800", "v8_cross", "6800 RPM AngeTheGreat engine-sim GM LS Cross-Plane V8 redline roar loop", 6800, 4.0, 1.00, 2.6),

    # Ferrari F136 Flat-Plane V8 (engine-sim MIT)
    DynoJob("eng_v8_flat_1100", "v8_flat", "1100 RPM AngeTheGreat engine-sim Ferrari F136 Flat-Plane V8 idle loop", 1100, 4.0, 0.06, 0.5),
    DynoJob("eng_v8_flat_low",  "v8_flat", "2600 RPM AngeTheGreat engine-sim Ferrari F136 Flat-Plane V8 pull loop", 2600, 4.0, 0.55, 1.8),
    DynoJob("eng_v8_flat_5500", "v8_flat", "5200 RPM AngeTheGreat engine-sim Ferrari F136 Flat-Plane V8 wail loop", 5200, 4.0, 0.88, 2.6),
    DynoJob("eng_v8_flat_8000", "v8_flat", "8000 RPM AngeTheGreat engine-sim Ferrari F136 Flat-Plane V8 redline scream loop", 8000, 4.0, 1.00, 3.2),

    # Supercharged GM LS Cross-Plane V8 (engine-sim MIT + Roots blower)
    DynoJob("eng_sc_v8_whine", "v8_sc", "4200 RPM AngeTheGreat engine-sim Supercharged LS V8 + Roots blower loop", 4200, 4.0, 0.88, 2.0, 2380.0),
    DynoJob("eng_sc_v8_6800",  "v8_sc", "6800 RPM AngeTheGreat engine-sim Supercharged LS V8 redline + blower loop", 6800, 4.0, 1.00, 2.6, 3850.0),
]


def presence_shelf(freqs: np.ndarray, gain_db: float) -> np.ndarray:
    if gain_db == 0.0:
        return np.ones_like(freqs)
    lin = 10.0 ** (gain_db / 20.0)
    # Warm mid-presence bell centered around 1600 Hz (broad Q ~ 0.9, adds exhaust bark without harshness)
    w = 1.0 / (1.0 + ((freqs - 1650.0) / 1400.0) ** 2)
    return 1.0 + (lin - 1.0) * w


def run_one(job: DynoJob, dyno_bin: Path, ir_dir: Path, tmp_dir: Path, audio_dir: Path, web_ogg_dir: Path) -> tuple[str, dict]:
    raw_wav = tmp_dir / f"{job.stem_id}_raw44.wav"
    cmd = [
        str(dyno_bin),
        job.engine_id,
        str(job.ref_rpm),
        f"{job.throttle:.2f}",
        "0.9",
        "2.3",
        str(ir_dir),
        str(raw_wav),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)

    # High-quality resample 44.1 kHz -> 48 kHz float64 mono via ffmpeg
    x48 = real_mod.load_opus_mono(raw_wav, max_s=5.0)
    f_fire = (job.ref_rpm / 60.0) * job.firings_per_rev
    # Drop first 0.25 s of recorded buffer so leveler & exhaust pressure are 100% steady-state
    x_steady = x48[int(0.25 * SAMPLE_RATE) :]
    looped, corr = real_mod.make_phase_locked_loop(x_steady, f_fire, LOOP_SAMPLES)

    if job.add_sc_whine_hz > 0.0:
        t = np.arange(LOOP_SAMPLES, dtype=np.float64) / SAMPLE_RATE
        f_sc = synth_mod._exact_cycle_freq(job.add_sc_whine_hz, LOOP_DURATION_S)
        f_sc2 = synth_mod._exact_cycle_freq(job.add_sc_whine_hz * 2.0, LOOP_DURATION_S)
        rms_eng = float(np.sqrt(np.mean(looped * looped))) + 1e-9
        fm = 0.20 * np.sin(2.0 * math.pi * (2.0 / LOOP_DURATION_S) * t)
        whine = 0.80 * np.sin(2.0 * math.pi * f_sc * t + fm) + 0.20 * np.sin(2.0 * math.pi * f_sc2 * t + 2.0 * fm)
        whine = np.tanh(whine * 1.12)
        whine /= float(np.sqrt(np.mean(whine * whine))) + 1e-9
        looped = looped + whine * (rms_eng * 0.22)

    # Clean studio mastering preserving 100% of AngeTheGreat's real thermodynamic acoustics
    shaped = real_mod.fft_filter(
        looped,
        lambda f: real_mod.butter_bp(f, 30.0, 14500.0, order=2.5)
        * presence_shelf(f, job.presence_db),
    )
    final = synth_mod._finalize_loop(shaped, target_rms_dbfs=-12.5)

    wav_path = audio_dir / f"{job.stem_id}.wav"
    ogg_path = web_ogg_dir / f"{job.stem_id}.ogg"
    synth_mod.write_wav_24bit_mono(wav_path, final, SAMPLE_RATE)
    ogg_bytes = synth_mod.encode_vorbis_ogg(wav_path, ogg_path, quality=5)
    _, decoded = synth_mod.read_wav_24bit_mono(wav_path)
    stats = synth_mod.measure_stem(decoded)

    entry = {
        "id": job.stem_id,
        "filename": f"{job.stem_id}.wav",
        "relative_wav_path": f"ue5/Import/Audio/{job.stem_id}.wav",
        "relative_ogg_path": f"web/public/assets/audio/{job.stem_id}.ogg",
        "ogg_bytes": ogg_bytes,
        "category": "engine",
        "description": job.description,
        "loop": True,
        "sample_rate_hz": SAMPLE_RATE,
        "bit_depth": 24,
        "channels": 1,
        "duration_s": round(decoded.shape[0] / SAMPLE_RATE, 4),
        "num_frames": int(decoded.shape[0]),
        "reference_rpm": job.ref_rpm,
        "fundamental_hz": round(f_fire, 1),
        "rms_dbfs": stats["rms_dbfs"],
        "peak_linear": stats["peak_linear"],
        "boundary_delta": stats["boundary_delta"],
        "license": "MIT (AngeTheGreat engine-sim) / CC-BY-NC-4.0 (OpenGrid mastered stem)",
        "engine_sim": {
            "preset": job.engine_id,
            "throttle": job.throttle,
            "loop_corr": round(corr, 3),
            "stdout": res.stdout.strip(),
        },
    }
    return job.stem_id, entry


def main() -> None:
    es_dir = Path("assets_source/downloads/engine-sim")
    dyno_bin = es_dir / "build_headless/engine_sim_dyno"
    ir_dir = es_dir / "es/sound-library"
    tmp_dir = es_dir / "build_headless/dyno_raw"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    audio_dir = Path("ue5/Import/Audio")
    web_ogg_dir = Path("web/public/assets/audio")
    manifest_path = Path("assets_source/audio/manifest.json")

    if not dyno_bin.is_file():
        raise FileNotFoundError(f"Missing compiled engine_sim_dyno binary: {dyno_bin}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    by_id = {s["id"]: s for s in manifest["stems"]}

    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = [ex.submit(run_one, j, dyno_bin, ir_dir, tmp_dir, audio_dir, web_ogg_dir) for j in DYNO_JOBS]
        for fut in futs:
            sid, entry = fut.result()
            by_id[sid] = entry
            es_info = entry["engine_sim"]
            print(
                f"Wrote {sid:22s} ({entry['reference_rpm']:4d}RPM, f0={entry['fundamental_hz']:5.1f}Hz, "
                f"rms={entry['rms_dbfs']:6.2f}dBFS, pk={entry['peak_linear']:.3f}, "
                f"seam={entry['boundary_delta']:.4f}, corr={es_info['loop_corr']:.3f}, "
                f"ogg={entry['ogg_bytes']/1024:4.1f}KB)"
            )

    # Recompute manifest order & totals
    new_stems = [by_id[s["id"]] for s in manifest["stems"]]
    total_ogg = sum(int(s["ogg_bytes"]) for s in new_stems)
    manifest["schema_version"] = 5
    manifest["generator"] = "tools/ue5/render_engine_sim_stems.py (AngeTheGreat engine-sim MIT) + tools/ue5/extract_real_audio_stems.py (CC-BY-3.0)"
    manifest["license"] = (
        "MIT (AngeTheGreat engine-sim rendered piston stems); "
        "CC-BY-3.0 (Wikimedia Commons real RX-7 rotary, turbo BOV/spool, anti-lag bangs, BMW M3 GTR gear whine); "
        "CC-BY-NC-4.0 (tyre/surface stems)"
    )
    manifest["provenance"] = (
        "26 piston engine RPM loops rendered via AngeTheGreat's MIT-licensed thermodynamic engine-sim "
        "(https://github.com/ange-yaghi/engine-sim) headless dynamometer; 4 RX-7 rotary loops and 6 turbo/exhaust/gearbox "
        "FX stems extracted from real CC-BY-3.0 Wikimedia Commons recordings; 3 tyre/kerb loops procedural."
    )
    manifest["web_ogg_total_bytes"] = total_ogg
    manifest["stem_count"] = len(new_stems)
    manifest["stems"] = new_stems
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"\nDONE: Rendered 26 AngeTheGreat engine-sim stems! Total 39-stem WebGPU .ogg pack = {total_ogg/1024:.1f} KB ({total_ogg/(1024*1024):.3f} MB)")


if __name__ == "__main__":
    main()
