#!/usr/bin/env python3
"""
Apache-2.0 — AngeTheGreat engine-sim (MIT) Headless Dyno + Zero-Voice FX Stem Builder
for OpenGrid (UE 5.8 + WebGPU).

Produces all 39 studio-clean, 100% speech-free, 48 kHz / 24-bit PCM WAV (UE 5.8) and compact
Vorbis OGG (WebGPU) automotive audio stems:
  - 26 Piston Engine RPM loops (4 exact dyno holds per architecture, full 1.50 s non-tiled loops!)
    rendered directly from AngeTheGreat's MIT-licensed thermodynamic `engine-sim`:
      * Porsche 911 GT3 4.0L Flat-6 Boxer (1000 / 2400 / 4800 / 7800 RPM)
      * Ferrari 412 T2 V12                (1000 / 2500 / 5000 / 8000 RPM)
      * Lexus LFA / Exotic 72° V10        (1000 / 2400 / 5200 / 7800 RPM)
      * Toyota 2JZ Inline-6               (1000 / 2400 / 4500 / 7000 RPM)
      * GM LS Cross-Plane V8              ( 900 / 2100 / 4200 / 6800 RPM)
      * Ferrari F136 Flat-Plane V8        (1100 / 2600 / 5200 / 8000 RPM)
      * Supercharged GM LS V8 + Roots     (4200 / 6800 RPM)
  - 4 Bridge-Port 4-Rotor / 787B Rotary loops (clean physical combustion DSP, zero voice)
  - 9 Visceral Zero-Voice FX stems:
      * turbo_spool_loop       (warm Garrett/BorgWarner compressor wheel spool + charge-pipe rush)
      * turbo_flutter_bov      (crisp 6-pulse aluminum intake compressor surge `stu-tu-tu-tu-tu-tu`)
      * exhaust_backfire_pop   (clean deep anti-lag shotgun bang + chest shockwave)
      * exhaust_antilag_pop2   (clean lower-pitched anti-lag overrun thump + double-crackle)
      * exhaust_antilag_pop3   (verified speech-free real Lamborghini Aventador SVJ Fi Exhaust bang, CC-BY-3.0)
      * gear_whine_straightcut (verified speech-free real BMW M3 GTR straight-cut transmission whine, CC-BY-3.0)
      * tyre_scrub_dry, tyre_spray_wet, kerb_rumble_strip (clean surface loops)
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
    load: float = 0.85
    stage: str = "race"
    presence_db: float = 0.0
    add_sc_whine_hz: float = 0.0


DYNO_JOBS: list[DynoJob] = [
    # Porsche 911 GT3 4.0L Flat-6 Boxer (vendored & enhanced engine-sim MIT)
    DynoJob("eng_flat6_1000", "flat6_na", "1000 RPM OpenGrid engine-sim Porsche GT3 Flat-6 idle loop", 1000, 3.0, 0.08, 0.10, "sport", 0.0),
    DynoJob("eng_flat6_low",  "flat6_na", "2400 RPM OpenGrid engine-sim Porsche GT3 Flat-6 low-mid pull loop", 2400, 3.0, 0.60, 0.65, "race", 1.0),
    DynoJob("eng_flat6_4000", "flat6_na", "4800 RPM OpenGrid engine-sim Porsche GT3 Flat-6 titanium howl loop", 4800, 3.0, 0.90, 0.92, "race", 1.8),
    DynoJob("eng_flat6_7800", "flat6_na", "7800 RPM OpenGrid engine-sim Porsche GT3 Flat-6 redline scream loop", 7800, 3.0, 1.00, 1.00, "race", 2.2),
    DynoJob("eng_flat6_decel", "flat6_na", "4800 RPM OpenGrid engine-sim Porsche GT3 Flat-6 off-throttle decel loop", 4800, 3.0, 0.04, 0.00, "race", 0.5),

    # Ferrari 6.5L NA V12
    DynoJob("eng_v12_1000", "v12_na", "1000 RPM OpenGrid engine-sim Ferrari V12 idle loop", 1000, 6.0, 0.08, 0.10, "sport", 0.0),
    DynoJob("eng_v12_low",  "v12_na", "2500 RPM OpenGrid engine-sim Ferrari V12 low-mid pull loop", 2500, 6.0, 0.60, 0.65, "race", 1.0),
    DynoJob("eng_v12_5000", "v12_na", "5000 RPM OpenGrid engine-sim Ferrari V12 F1 soprano howl loop", 5000, 6.0, 0.90, 0.92, "race", 1.8),
    DynoJob("eng_v12_8000", "v12_na", "8000 RPM OpenGrid engine-sim Ferrari V12 redline scream loop", 8000, 6.0, 1.00, 1.00, "race", 2.2),
    DynoJob("eng_v12_decel", "v12_na", "5200 RPM OpenGrid engine-sim Ferrari V12 off-throttle decel loop", 5200, 6.0, 0.04, 0.00, "race", 0.5),

    # Lexus LFA / Huracan 72deg Odd-Fire V10
    DynoJob("eng_v10_1000", "v10_screamer", "1000 RPM OpenGrid engine-sim V10 idle loop", 1000, 5.0, 0.08, 0.10, "sport", 0.0),
    DynoJob("eng_v10_low",  "v10_screamer", "2400 RPM OpenGrid engine-sim V10 low-mid pull loop", 2400, 5.0, 0.60, 0.65, "race", 1.2),
    DynoJob("eng_v10_5500", "v10_screamer", "5200 RPM OpenGrid engine-sim V10 angel howl loop", 5200, 5.0, 0.90, 0.92, "race", 2.0),
    DynoJob("eng_v10_7800", "v10_screamer", "7800 RPM OpenGrid engine-sim V10 redline scream loop", 7800, 5.0, 1.00, 1.00, "race", 2.4),
    DynoJob("eng_v10_decel", "v10_screamer", "5200 RPM OpenGrid engine-sim V10 off-throttle decel loop", 5200, 5.0, 0.04, 0.00, "race", 0.5),

    # Toyota 2JZ / RB26 Forged TT Inline-6
    DynoJob("eng_tt_i6_1000", "i6_forged", "1000 RPM OpenGrid engine-sim Forged I6 idle loop", 1000, 3.0, 0.08, 0.10, "sport", 0.0),
    DynoJob("eng_tt_i6_low",  "i6_forged", "2400 RPM OpenGrid engine-sim Forged I6 baritone pull loop", 2400, 3.0, 0.62, 0.68, "race", 1.0),
    DynoJob("eng_tt_i6_4000", "i6_forged", "4500 RPM OpenGrid engine-sim Forged I6 boost roar loop", 4500, 3.0, 0.90, 0.92, "race", 1.5),
    DynoJob("eng_tt_i6_7000", "i6_forged", "7000 RPM OpenGrid engine-sim Forged I6 redline wail loop", 7000, 3.0, 1.00, 1.00, "race", 2.0),
    DynoJob("eng_tt_i6_decel", "i6_forged", "4600 RPM OpenGrid engine-sim Forged I6 off-throttle decel loop", 4600, 3.0, 0.04, 0.00, "race", 0.4),

    # Dedicated 3.5L 60deg Twin-Turbo V6 (NSX / Group-B)
    DynoJob("eng_v6_tt_1000", "v6_tt", "1000 RPM OpenGrid engine-sim 60deg TT V6 idle loop", 1000, 3.0, 0.08, 0.10, "sport", 0.0),
    DynoJob("eng_v6_tt_low",  "v6_tt", "2400 RPM OpenGrid engine-sim 60deg TT V6 pull loop", 2400, 3.0, 0.62, 0.68, "race", 1.0),
    DynoJob("eng_v6_tt_4500", "v6_tt", "4500 RPM OpenGrid engine-sim 60deg TT V6 roar loop", 4500, 3.0, 0.90, 0.92, "race", 1.6),
    DynoJob("eng_v6_tt_7200", "v6_tt", "7200 RPM OpenGrid engine-sim 60deg TT V6 redline scream loop", 7200, 3.0, 1.00, 1.00, "race", 2.0),
    DynoJob("eng_v6_tt_decel", "v6_tt", "4600 RPM OpenGrid engine-sim 60deg TT V6 off-throttle decel loop", 4600, 3.0, 0.04, 0.00, "race", 0.4),

    # GM LS / Hellhound 6.2L Cross-Plane V8
    DynoJob("eng_v8_cross_900",  "v8_crossplane", "900 RPM OpenGrid engine-sim Cross-Plane V8 lope idle loop", 900, 4.0, 0.08, 0.10, "sport", 0.0),
    DynoJob("eng_v8_cross_low",  "v8_crossplane", "2100 RPM OpenGrid engine-sim Cross-Plane V8 muscle pull loop", 2100, 4.0, 0.65, 0.70, "race", 0.8),
    DynoJob("eng_v8_cross_4200", "v8_crossplane", "4200 RPM OpenGrid engine-sim Cross-Plane V8 thunder roar loop", 4200, 4.0, 0.92, 0.95, "race", 1.4),
    DynoJob("eng_v8_cross_6800", "v8_crossplane", "6800 RPM OpenGrid engine-sim Cross-Plane V8 redline roar loop", 6800, 4.0, 1.00, 1.00, "race", 1.8),
    DynoJob("eng_v8_cross_decel", "v8_crossplane", "4200 RPM OpenGrid engine-sim Cross-Plane V8 off-throttle decel loop", 4200, 4.0, 0.04, 0.00, "race", 0.4),

    # Ferrari F136 Flat-Plane V8
    DynoJob("eng_v8_flat_1100", "v8_flatplane", "1100 RPM OpenGrid engine-sim Flat-Plane V8 idle loop", 1100, 4.0, 0.08, 0.10, "sport", 0.0),
    DynoJob("eng_v8_flat_low",  "v8_flatplane", "2600 RPM OpenGrid engine-sim Flat-Plane V8 pull loop", 2600, 4.0, 0.62, 0.68, "race", 1.2),
    DynoJob("eng_v8_flat_5500", "v8_flatplane", "5200 RPM OpenGrid engine-sim Flat-Plane V8 wail loop", 5200, 4.0, 0.90, 0.92, "race", 1.8),
    DynoJob("eng_v8_flat_8000", "v8_flatplane", "8000 RPM OpenGrid engine-sim Flat-Plane V8 redline scream loop", 8000, 4.0, 1.00, 1.00, "race", 2.2),
    DynoJob("eng_v8_flat_decel", "v8_flatplane", "5200 RPM OpenGrid engine-sim Flat-Plane V8 off-throttle decel loop", 5200, 4.0, 0.04, 0.00, "race", 0.5),

    # Supercharged 6.2L Cross-Plane V8 (built-in helical Roots blower in C++!)
    DynoJob("eng_sc_v8_whine", "v8_supercharged", "4200 RPM OpenGrid engine-sim Supercharged V8 + helical blower loop", 4200, 4.0, 0.92, 0.95, "race", 1.4, 0.0),
    DynoJob("eng_sc_v8_6800",  "v8_supercharged", "6800 RPM OpenGrid engine-sim Supercharged V8 redline + blower loop", 6800, 4.0, 1.00, 1.00, "race", 1.8, 0.0),

    # Dedicated 26B 4-Rotor Peripheral-Port Wankel (from our C++ Rotary4Core!)
    DynoJob("eng_rotary4_1100", "rotary_4", "1100 RPM OpenGrid 26B 4-Rotor peripheral-port BRAP idle loop", 1100, 4.0, 0.08, 0.10, "sport", 0.0),
    DynoJob("eng_rotary4_low",  "rotary_4", "2600 RPM OpenGrid 26B 4-Rotor pull loop", 2600, 4.0, 0.65, 0.70, "race", 0.8),
    DynoJob("eng_rotary4_6000", "rotary_4", "5500 RPM OpenGrid 26B 4-Rotor 787B howl loop", 5500, 4.0, 0.92, 0.95, "race", 1.2),
    DynoJob("eng_rotary4_8500", "rotary_4", "8500 RPM OpenGrid 26B 4-Rotor redline razor shriek loop", 8500, 4.0, 1.00, 1.00, "race", 1.6),
    DynoJob("eng_rotary4_decel", "rotary_4", "5400 RPM OpenGrid 26B 4-Rotor off-throttle decel loop", 5400, 4.0, 0.04, 0.00, "race", 0.4),
]


def make_full_length_seamless_loop(x: np.ndarray, f_fire: float, target_samples: int = LOOP_SAMPLES) -> tuple[np.ndarray, float]:
    """
    Build a full 1.50 s organic seamless loop (NO short 0.25 s tiling!) from a 2.0+ s constant-RPM
    engine-sim capture by finding the exact phase-aligned splice around `target_samples` (~1.50 s)
    and equal-power cos/sin crossfading a ~95 ms overlap window.
    """
    x = x - float(np.mean(x))
    n = x.shape[0]
    xf = min(int(0.095 * SAMPLE_RATE), max(512, int(round(5.0 * SAMPLE_RATE / max(30.0, f_fire)))))
    # Search L in [target_samples - 0.12s, min(target_samples + 0.12s, n - xf - 1)]
    l_lo = max(xf + 1024, target_samples - int(0.12 * SAMPLE_RATE))
    l_hi = min(n - xf - 1, target_samples + int(0.12 * SAMPLE_RATE))
    if l_hi <= l_lo + 16:
        return real_mod.make_phase_locked_loop(x, f_fire, target_samples)

    head = x[:xf]
    head_norm = float(np.linalg.norm(head)) + 1e-12
    p_samp = SAMPLE_RATE / max(20.0, f_fire)
    k_lo = max(1, int(math.ceil(l_lo / p_samp)))
    k_hi = max(k_lo, int(math.floor(l_hi / p_samp)))
    best_corr = -2.0
    l_best = min(target_samples, l_hi)
    for k in range(k_lo, k_hi + 1):
        c_idx = int(round(k * p_samp))
        for L in range(max(l_lo, c_idx - 12), min(l_hi, c_idx + 12) + 1, 2):
            tail = x[L : L + xf]
            c = float(np.dot(head, tail)) / (head_norm * (float(np.linalg.norm(tail)) + 1e-12))
            if c > best_corr:
                best_corr = c
                l_best = L
    for L in range(max(l_lo, l_best - 3), min(l_hi, l_best + 3) + 1):
        tail = x[L : L + xf]
        c = float(np.dot(head, tail)) / (head_norm * (float(np.linalg.norm(tail)) + 1e-12))
        if c > best_corr:
            best_corr = c
            l_best = L

    ang = np.linspace(0.0, 0.5 * math.pi, xf, endpoint=False)
    base = np.empty(l_best, dtype=np.float64)
    base[:xf] = x[l_best : l_best + xf] * np.cos(ang) + x[:xf] * np.sin(ang)
    base[xf:] = x[xf:l_best]

    if base.shape[0] != target_samples:
        m = base.shape[0]
        pos = np.linspace(0.0, m, target_samples, endpoint=False)
        i0 = np.floor(pos).astype(np.int64) % m
        u = pos - np.floor(pos)
        p0, p1, p2, p3 = base[(i0 - 1) % m], base[i0], base[(i0 + 1) % m], base[(i0 + 2) % m]
        u2, u3 = u * u, u * u * u
        base = 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3)
    return base, best_corr


def presence_shelf(freqs: np.ndarray, gain_db: float) -> np.ndarray:
    if gain_db == 0.0:
        return np.ones_like(freqs)
    lin = 10.0 ** (gain_db / 20.0)
    w = 1.0 / (1.0 + ((freqs - 1650.0) / 1400.0) ** 2)
    return 1.0 + (lin - 1.0) * w


def synth_clean_warm_turbo_spool(rng: np.random.Generator) -> np.ndarray:
    """
    1.50 s zero-voice, zero-RC-car Garrett/BorgWarner turbocharger compressor spool loop:
    warm 2400 Hz & 4800 Hz blade-pass whistle + pressurized charge-pipe intake whoosh (1400–5200 Hz).
    """
    n = LOOP_SAMPLES
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    f1 = synth_mod._exact_cycle_freq(2400.0, LOOP_DURATION_S)
    f2 = synth_mod._exact_cycle_freq(4800.0, LOOP_DURATION_S)
    fm = 0.25 * np.sin(2.0 * math.pi * (2.0 / LOOP_DURATION_S) * t) + 0.12 * np.sin(2.0 * math.pi * (4.0 / LOOP_DURATION_S) * t + 1.1)
    wheel = (
        0.78 * np.sin(2.0 * math.pi * f1 * t + fm)
        + 0.20 * np.sin(2.0 * math.pi * f2 * t + 2.0 * fm + 0.4)
        + 0.08 * np.sin(2.0 * math.pi * (f1 + 40.0) * t + fm)
    )
    wheel = np.tanh(wheel * 1.05)
    wheel /= float(np.sqrt(np.mean(wheel * wheel))) + 1e-9

    # Pressurized charge-pipe air whoosh (1400..5400 Hz smooth aerodynamic rush)
    air = real_mod.fft_filter(
        rng.standard_normal(n),
        lambda f: real_mod.butter_bp(f, 1350.0, 5400.0, order=2.5)
        * (1.0 + 1.2 / (1.0 + ((f - 2500.0) / 700.0) ** 2)),
    )
    air /= float(np.sqrt(np.mean(air * air))) + 1e-9

    # Subtle 1.33 Hz boost breathing (100% periodic)
    breath = 1.0 + 0.05 * np.sin(2.0 * math.pi * (2.0 / LOOP_DURATION_S) * t)
    return synth_mod._finalize_loop((0.46 * wheel + 0.54 * air) * breath, target_rms_dbfs=-13.0)


def synth_deep_antilag_pop(rng: np.random.Generator, pitch_scale: float = 1.0, double_pop: bool = False) -> np.ndarray:
    """
    0.55 s zero-voice, chest-thumping rally/supercar anti-lag gunshot bang + natural exhaust decay.
    """
    dur_s = 0.55
    n = int(round(SAMPLE_RATE * dur_s))
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE

    def one_bang(t0: float, amp: float, p_mul: float) -> np.ndarray:
        dt = np.maximum(0.0, t - t0)
        active = (t >= t0).astype(np.float64)
        # Chest-punch sub-bass shockwave (135 Hz -> 42 Hz rapid pitch drop over 45 ms)
        f_inst = (42.0 + 95.0 * np.exp(-dt / 0.018)) * p_mul
        ph = 2.0 * math.pi * np.cumsum(f_inst) / SAMPLE_RATE
        sub = np.sin(ph) * np.exp(-dt / 0.048) * (1.0 - np.exp(-dt / 0.0012))

        # Explosive exhaust crack (wideband 180..4200 Hz gas detonation transient)
        raw_n = rng.standard_normal(n)
        crack = real_mod.fft_filter(
            raw_n,
            lambda f: real_mod.butter_bp(f, 140.0 * p_mul, 4400.0 * p_mul, order=2.0)
            * (1.0 + 1.8 / (1.0 + ((f - 520.0 * p_mul) / 260.0) ** 2)),
        )
        crack /= float(np.sqrt(np.mean(crack * crack))) + 1e-9
        env_crack = (np.exp(-dt / 0.014) * 0.85 + np.exp(-dt / 0.075) * 0.35) * (1.0 - np.exp(-dt / 0.0008))

        # Warm outdoor tailpipe reflection tail
        tail_n = real_mod.fft_filter(rng.standard_normal(n), lambda f: real_mod.butter_bp(f, 90.0, 1800.0, order=2.0))
        tail_n /= float(np.sqrt(np.mean(tail_n * tail_n))) + 1e-9
        env_tail = np.exp(-dt / 0.14) * (1.0 - np.exp(-dt / 0.012)) * 0.24

        return active * amp * (0.95 * sub + 1.15 * crack * env_crack + tail_n * env_tail)

    y = one_bang(0.010, 1.0, pitch_scale)
    if double_pop:
        y = y + one_bang(0.115, 0.62, pitch_scale * 0.92)
    y = np.tanh(y * 1.35)
    return synth_mod._finalize_oneshot(y, target_rms_dbfs=-11.5, fade_in_ms=1.5, fade_out_ms=70.0)


def run_dyno_job(job: DynoJob, dyno_bin: Path, tmp_dir: Path, audio_dir: Path, web_ogg_dir: Path) -> tuple[str, dict]:
    raw_wav = tmp_dir / f"{job.stem_id}_raw48.wav"
    cmd = [
        str(dyno_bin),
        "hold",
        job.engine_id,
        str(job.ref_rpm),
        f"{job.throttle:.2f}",
        f"{job.load:.2f}",
        "0.65",
        "2.2",
        job.stage,
        str(raw_wav),
        "mono",
    ]
    subprocess.run(cmd, capture_output=True, text=True, check=True)
    x48 = real_mod.load_opus_mono(raw_wav, max_s=5.0)
    f_fire = (job.ref_rpm / 60.0) * job.firings_per_rev
    x_steady = x48[int(0.22 * SAMPLE_RATE) :]
    looped, corr = make_full_length_seamless_loop(x_steady, f_fire, LOOP_SAMPLES)

    shaped = real_mod.fft_filter(
        looped,
        lambda f: real_mod.butter_bp(f, 28.0, 14500.0, order=2.5)
        * presence_shelf(f, job.presence_db),
    )
    target_db = -14.0 if job.load <= 0.05 else -12.2
    final = synth_mod._finalize_loop(shaped, target_rms_dbfs=target_db)

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
        "license": "MIT (AngeTheGreat engine-sim, vendored in core/third_party/engine_sim/) + Apache-2.0 OpenGrid DSP",
        "engine_sim": {
            "preset": job.engine_id,
            "throttle": job.throttle,
            "load": job.load,
            "stage": job.stage,
            "loop_corr": round(corr, 3),
        },
    }
    return job.stem_id, entry


def main() -> None:
    dyno_bin = Path("core/build/opengrid_engine_dyno")
    if not dyno_bin.is_file():
        raise FileNotFoundError(f"Build {dyno_bin} first: cmake -S core -B core/build -DCMAKE_BUILD_TYPE=Release && cmake --build core/build -j")
    tmp_dir = Path("/tmp/og_engine_dyno_raw")
    tmp_dir.mkdir(parents=True, exist_ok=True)
    audio_dir = Path("ue5/Import/Audio")
    web_ogg_dir = Path("web/public/assets/audio")
    manifest_path = Path("assets_source/audio/manifest.json")

    old_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    old_by_id = {s["id"]: s for s in old_manifest["stems"]}
    raw_meta = json.loads(Path("assets_source/downloads/commons_audio/metadata.json").read_text(encoding="utf-8"))

    by_id: dict[str, dict] = {}

    # 1) All 42 vendored & enhanced OpenGrid engine-sim stems (ON-LOAD WOT + OFF-LOAD DECEL + V6 TT + 26B 4-Rotor!)
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = [ex.submit(run_dyno_job, j, dyno_bin, tmp_dir, audio_dir, web_ogg_dir) for j in DYNO_JOBS]
        for fut in futs:
            sid, entry = fut.result()
            by_id[sid] = entry
            print(
                f"Wrote {sid:22s} ({entry['reference_rpm']:4d}RPM, load={entry['engine_sim']['load']:.1f}, "
                f"rms={entry['rms_dbfs']:6.2f}dBFS, pk={entry['peak_linear']:.3f}, seam={entry['boundary_delta']:.4f}, "
                f"corr={entry['engine_sim']['loop_corr']:.3f}, ogg={entry['ogg_bytes']/1024:4.1f}KB)"
            )

    def write_custom_stem(sid: str, category: str, desc: str, loop: bool, ref_rpm: int | None, f0: float, samples: np.ndarray, lic: str):
        wav_path = audio_dir / f"{sid}.wav"
        ogg_path = web_ogg_dir / f"{sid}.ogg"
        synth_mod.write_wav_24bit_mono(wav_path, samples, SAMPLE_RATE)
        ogg_bytes = synth_mod.encode_vorbis_ogg(wav_path, ogg_path, quality=5)
        _, decoded = synth_mod.read_wav_24bit_mono(wav_path)
        stats = synth_mod.measure_stem(decoded)
        by_id[sid] = {
            "id": sid,
            "filename": f"{sid}.wav",
            "relative_wav_path": f"ue5/Import/Audio/{sid}.wav",
            "relative_ogg_path": f"web/public/assets/audio/{sid}.ogg",
            "ogg_bytes": ogg_bytes,
            "category": category,
            "description": desc,
            "loop": loop,
            "sample_rate_hz": SAMPLE_RATE,
            "bit_depth": 24,
            "channels": 1,
            "duration_s": round(decoded.shape[0] / SAMPLE_RATE, 4),
            "num_frames": int(decoded.shape[0]),
            "reference_rpm": ref_rpm,
            "fundamental_hz": f0,
            "rms_dbfs": stats["rms_dbfs"],
            "peak_linear": stats["peak_linear"],
            "boundary_delta": stats["boundary_delta"],
            "license": lic,
        }
        print(f"Wrote {sid:22s} (clean DSP, rms={stats['rms_dbfs']:6.2f}dBFS, pk={stats['peak_linear']:.3f}, seam={stats['boundary_delta']:.4f}, ogg={ogg_bytes/1024:4.1f}KB)")

    # 2) Clean zero-voice Turbo Spool, Turbo BOV Flutter, and 2x Deep Anti-Lag Bangs
    write_custom_stem("turbo_spool_loop", "drivetrain_induction",
                      "Warm Garrett/BorgWarner turbocharger compressor spool + pressurized charge-pipe rush loop",
                      True, None, 2400.0, synth_clean_warm_turbo_spool(np.random.default_rng(20261191)), "CC-BY-NC-4.0")
    write_custom_stem("turbo_flutter_bov", "drivetrain_induction",
                      "Crisp 6-pulse turbo compressor-surge flutter (stu-tu-tu-tu-tu-tu) + aluminum charge-pipe ring",
                      False, None, 1870.0, synth_mod.synth_turbo_flutter_bov(np.random.default_rng(20261192)), "CC-BY-NC-4.0")
    write_custom_stem("exhaust_backfire_pop", "drivetrain_induction",
                      "Deep anti-lag exhaust shotgun bang + chest-punch sub-bass shockwave",
                      False, None, 110.0, synth_deep_antilag_pop(np.random.default_rng(20261193), 1.0, False), "CC-BY-NC-4.0")
    write_custom_stem("exhaust_antilag_pop2", "drivetrain_induction",
                      "Deep low-pitched anti-lag overrun double-pop bang",
                      False, None, 92.0, synth_deep_antilag_pop(np.random.default_rng(20261194), 0.86, True), "CC-BY-NC-4.0")

    # 3) Keep verified speech-free CC-BY-3.0 real stems (Aventador SVJ bang + BMW M3 GTR gearbox whine) + surface loops
    for keep_id in ["exhaust_antilag_pop3", "gear_whine_straightcut", "tyre_scrub_dry", "tyre_spray_wet", "kerb_rumble_strip"]:
        by_id[keep_id] = old_by_id[keep_id]

    ordered_ids = [j.stem_id for j in DYNO_JOBS] + [
        "turbo_spool_loop", "turbo_flutter_bov", "exhaust_backfire_pop", "exhaust_antilag_pop2",
        "exhaust_antilag_pop3", "gear_whine_straightcut", "tyre_scrub_dry", "tyre_spray_wet", "kerb_rumble_strip",
    ]
    new_stems = [by_id[sid] for sid in ordered_ids]
    total_ogg = sum(int(s["ogg_bytes"]) for s in new_stems)

    used_cc_keys = ["v12_svj_fi", "fx_m3_gtr"]
    manifest = {
        "schema_version": 7,
        "generator": "tools/ue5/render_engine_sim_stems.py via core/build/opengrid_engine_dyno (vendored MIT engine-sim + OpenGrid Forza dual-mic DSP)",
        "license": "MIT (AngeTheGreat engine-sim vendored in core/third_party/engine_sim/); CC-BY-3.0 (Aventador SVJ bang & BMW M3 GTR gear whine); CC-BY-NC-4.0 (OpenGrid FX/DSP)",
        "provenance": (
            "42 dual-load (ON-LOAD WOT + OFF-LOAD DECEL) engine RPM loops across 9 architectures "
            "(Flat-6 GT3, Ferrari V12, Odd-Fire V10, 2JZ TT I6, 60deg TT V6, Cross-Plane V8, Flat-Plane V8, "
            "Supercharged LS V8, 26B 4-Rotor Wankel) rendered by OpenGrid's vendored & improved MIT engine-sim "
            "C++ engine (core/src/engine_audio.cpp + core/third_party/engine_sim/); 2 verified speech-free CC-BY-3.0 "
            "real FX stems (Lamborghini Aventador SVJ bang, BMW M3 GTR gearbox whine); 7 zero-voice procedural FX stems."
        ),
        "sample_rate_hz": SAMPLE_RATE,
        "bit_depth": 24,
        "channels": 1,
        "output_dir": "ue5/Import/Audio",
        "web_ogg_dir": "web/public/assets/audio",
        "web_ogg_total_bytes": total_ogg,
        "stem_count": len(new_stems),
        "sources_used": [
            {
                "key": k,
                "wikimedia_title": raw_meta[k]["title"],
                "commons_url": raw_meta[k]["commons_url"],
                "author": raw_meta[k]["author"],
                "licence": "CC-BY-3.0",
                "licence_url": "https://creativecommons.org/licenses/by/3.0/",
            }
            for k in used_cc_keys
        ],
        "stems": new_stems,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"\nDONE: All {len(new_stems)} Forza dual-load stems built! Total WebGPU .ogg pack = {total_ogg/1024:.1f} KB ({total_ogg/(1024*1024):.3f} MB)")


if __name__ == "__main__":
    main()
