#!/usr/bin/env python3
"""
Apache-2.0 — Procedural 48 kHz / 24-bit PCM WAV MetaSound stem generator for OpenGrid (UE 5.8).

Synthesizes 11 clean, band-limited, seamlessly-looping (or cleanly windowed one-shot) automotive
audio stems using 100% original procedural DSP (zero third-party samples; output licence CC-BY-NC-4.0):

  Engine loops (2.0 s, exact integer-cycle seamless loops):
    - eng_flat6_4000.wav         (4000 RPM Flat-6 boxer, f0 = 200.0 Hz)
    - eng_v12_5000.wav           (5000 RPM NA V12 exotic, f0 = 500.0 Hz)
    - eng_rotary4_6000.wav       (6000 RPM 4-rotor Wankel, f0 = 400.0 Hz)
    - eng_tt_i6_4000.wav         (4000 RPM Twin-Turbo Inline-6, f0 = 200.0 Hz)
    - eng_sc_v8_whine.wav        (4000 RPM Supercharged V8 + blower whine, f0 = 266.5 Hz)

  Drivetrain & induction stems:
    - gear_whine_straightcut.wav (2.0 s loop, straight-cut sequential tooth-mesh, f0 = 1200.0 Hz)
    - turbo_flutter_bov.wav      (1.1 s one-shot, compressor-surge blow-off valve flutter)
    - exhaust_backfire_pop.wav   (0.55 s one-shot, overrun detonation / shift-cut bang)

  Tyre & road surface loops (2.0 s seamless loops):
    - tyre_scrub_dry.wav         (dry asphalt stick-slip squeal + 225 Hz cavity resonance)
    - tyre_spray_wet.wav         (wet asphalt hydro-spray hiss + turbulent splash body)
    - kerb_rumble_strip.wav      (32.0 Hz kerb block impacts + 225 Hz toroidal cavity ring)

Outputs:
  - `ue5/Import/Audio/*.wav`           (gitignored large 48 kHz / 24-bit mono PCM WAV stems)
  - `assets_source/audio/manifest.json` (tracked metadata & provenance ledger)

Usage:
  python3 tools/ue5/generate_audio_stems.py
  python3 tools/ue5/generate_audio_stems.py --verify
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np

SAMPLE_RATE = 48000
BIT_DEPTH = 24
CHANNELS = 1
STEM_LICENSE = "CC-BY-NC-4.0"
PROVENANCE = "100% original procedural DSP synthesis (OpenGrid) — zero third-party samples"


@dataclass(frozen=True)
class StemSpec:
    stem_id: str
    filename: str
    category: str
    description: str
    loop: bool
    duration_s: float
    reference_rpm: int | None
    fundamental_hz: float
    synth_fn: Callable[[np.random.Generator], np.ndarray]


# ---- DSP primitives ------------------------------------------------------------------------------


def _nyquist_taper(freq_hz: float, sr: int = SAMPLE_RATE) -> float:
    """Smooth cosine band-limit rolloff between 0.38*sr and 0.45*sr to guarantee zero aliasing."""
    lo = 0.38 * sr
    hi = 0.45 * sr
    if freq_hz <= lo:
        return 1.0
    if freq_hz >= hi:
        return 0.0
    t = (freq_hz - lo) / (hi - lo)
    return 0.5 * (1.0 + math.cos(math.pi * t))


def _exact_cycle_freq(freq_hz: float, duration_s: float) -> float:
    """Snap frequency to exact integer number of cycles over duration_s for seamless wraparound."""
    cycles = max(1, int(round(freq_hz * duration_s)))
    return cycles / duration_s


def _harmonic_sum(
    t: np.ndarray,
    duration_s: float,
    partials: list[tuple[float, float, float]],
    sr: int = SAMPLE_RATE,
) -> np.ndarray:
    """Sum band-limited sinusoids snapped to exact integer cycles over duration_s."""
    out = np.zeros_like(t, dtype=np.float64)
    two_pi = 2.0 * math.pi
    for freq, amp, phase in partials:
        if freq <= 0.0 or amp == 0.0:
            continue
        f_exact = _exact_cycle_freq(freq, duration_s)
        taper = _nyquist_taper(f_exact, sr)
        if taper <= 0.0:
            continue
        out += (amp * taper) * np.sin(two_pi * f_exact * t + phase)
    return out


def _circular_fft_shape(
    x: np.ndarray,
    response_fn: Callable[[np.ndarray], np.ndarray],
    sr: int = SAMPLE_RATE,
) -> np.ndarray:
    """Apply a zero-phase frequency response via rFFT/irFFT (mathematically periodic on [0, N))."""
    n = x.shape[0]
    freqs = np.fft.rfftfreq(n, d=1.0 / sr)
    spec = np.fft.rfft(x)
    gain = np.asarray(response_fn(freqs), dtype=np.float64)
    # Always kill DC and near-Nyquist energy cleanly
    gain[0] = 0.0
    gain *= np.clip((0.46 * sr - freqs) / (0.04 * sr), 0.0, 1.0)
    return np.fft.irfft(spec * gain, n=n)


def _bandpass_curve(freqs: np.ndarray, f_lo: float, f_hi: float, order: float = 4.0) -> np.ndarray:
    """Smooth Butterworth-like magnitude bandpass curve."""
    f_safe = np.maximum(freqs, 1e-6)
    hp = 1.0 / np.sqrt(1.0 + (f_lo / f_safe) ** (2.0 * order))
    lp = 1.0 / np.sqrt(1.0 + (f_safe / f_hi) ** (2.0 * order))
    return hp * lp


def _resonator_bank(freqs: np.ndarray, formants: list[tuple[float, float, float]]) -> np.ndarray:
    """Sum of Lorentzian formant peaks: list of (center_hz, bandwidth_hz, gain)."""
    h = np.ones_like(freqs, dtype=np.float64)
    for fc, bw, g in formants:
        h += g / (1.0 + ((freqs - fc) / bw) ** 2)
    return h


def _soft_limit(x: np.ndarray, threshold: float = 0.85, ceiling: float = 0.94) -> np.ndarray:
    """Smooth memoryless soft limiter preserving periodicity of loops."""
    peak = float(np.max(np.abs(x)))
    if peak <= threshold:
        return x
    # Cubic/tanh knee above threshold
    abs_x = np.abs(x)
    over = np.maximum(abs_x - threshold, 0.0)
    headroom = ceiling - threshold
    limited = np.where(
        abs_x > threshold,
        np.sign(x) * (threshold + headroom * np.tanh(over / headroom)),
        x,
    )
    return limited


def _align_loop_boundary(x: np.ndarray) -> np.ndarray:
    """
    Circularly rotate a periodic loop to the cleanest boundary point where both
    |x[i] - x[i-1]| and |x[i]| are minimal, guaranteeing zero click and |end - start| << 0.02.
    """
    prev = np.roll(x, 1)
    step = np.abs(x - prev)
    score = step + 0.35 * np.abs(x)
    best = int(np.argmin(score))
    return np.roll(x, -best)


def _finalize_loop(x: np.ndarray, target_rms_dbfs: float = -14.0) -> np.ndarray:
    """Remove DC, normalize to target RMS, soft-limit, and align loop seam."""
    y = x - float(np.mean(x))
    rms = float(np.sqrt(np.mean(y * y)))
    if rms > 1e-12:
        target_rms = 10.0 ** (target_rms_dbfs / 20.0)
        y = y * (target_rms / rms)
    y = _soft_limit(y, threshold=0.82, ceiling=0.93)
    # Re-center & re-check RMS after soft limit
    y = y - float(np.mean(y))
    peak = float(np.max(np.abs(y)))
    if peak > 0.96:
        y = y * (0.95 / peak)
    return _align_loop_boundary(y)


def _finalize_oneshot(
    x: np.ndarray,
    target_rms_dbfs: float = -14.0,
    fade_in_ms: float = 4.0,
    fade_out_ms: float = 35.0,
    sr: int = SAMPLE_RATE,
) -> np.ndarray:
    """High-pass DC, normalize RMS, soft-limit, and apply cosine fade-in/out to exact zero."""
    y = _circular_fft_shape(x, lambda f: _bandpass_curve(f, 22.0, 18500.0, order=2.0), sr)
    n = y.shape[0]
    n_in = min(n // 4, max(8, int(sr * fade_in_ms * 1e-3)))
    n_out = min(n // 2, max(16, int(sr * fade_out_ms * 1e-3)))
    env = np.ones(n, dtype=np.float64)
    env[:n_in] = 0.5 * (1.0 - np.cos(math.pi * np.linspace(0.0, 1.0, n_in)))
    env[-n_out:] = 0.5 * (1.0 + np.cos(math.pi * np.linspace(0.0, 1.0, n_out)))
    y = y * env

    rms = float(np.sqrt(np.mean(y * y)))
    if rms > 1e-12:
        target_rms = 10.0 ** (target_rms_dbfs / 20.0)
        y = y * (target_rms / rms)
    y = _soft_limit(y, threshold=0.82, ceiling=0.94)
    # Re-apply endpoints exact zero taper
    y[0] = 0.0
    y[-1] = 0.0
    return y


# ---- Engine Loop Synthesizers (2.0 s seamless loops) ---------------------------------------------


def synth_eng_flat6_4000(rng: np.random.Generator) -> np.ndarray:
    """
    4000 RPM Flat-6 (GT3 RS boxer howl):
      Crank = 66.5 Hz (133 cycles / 2 s), primary firing = 200.0 Hz (400 cycles / 2 s).
      Rich 3rd/6th/9th crank orders, metallic titanium exhaust formant around 1.25-2.6 kHz,
      subtle asymmetric bank collector pulse & circularly filtered intake breath.
    """
    dur = 2.0
    n = int(SAMPLE_RATE * dur)
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    f0 = 200.0  # 4000 * 6 / 120
    f_crank = 66.5

    partials: list[tuple[float, float, float]] = [
        # Subtle boxer crank sub-orders
        (f_crank * 1.0, 0.14, 0.2),
        (f_crank * 1.5, 0.10, 1.1),
        (f_crank * 2.0, 0.16, 0.5),
        (f_crank * 2.5, 0.07, 2.3),
    ]
    # Strong firing harmonics (1..24) with GT3 upper-mid metallic howl
    for h in range(1, 25):
        freq = f0 * h
        base_amp = 1.0 / (h ** 0.92)
        if h in (2, 3, 5, 6, 7):
            base_amp *= 1.35
        phase = float(rng.uniform(0.0, 2.0 * math.pi))
        partials.append((freq, base_amp, phase))
        # Subtle half-firing order sidebands (uneven bank scavenging)
        if h <= 10:
            partials.append((freq + f0 * 0.5, base_amp * 0.14, float(rng.uniform(0.0, 2.0 * math.pi))))

    core = _harmonic_sum(t, dur, partials)
    # Mild asymmetric exhaust waveshaping + subtle periodic combustion micro-modulation
    lfo = 1.0 + 0.045 * np.sin(2.0 * math.pi * 1.5 * t) + 0.025 * np.sin(2.0 * math.pi * 4.0 * t + 0.8)
    core = np.tanh(core * 0.55) * lfo

    # Titanium exhaust collector & intake plenum formants
    core = _circular_fft_shape(
        core,
        lambda f: _bandpass_curve(f, 55.0, 9500.0, order=2.0)
        * _resonator_bank(f, [(200.0, 65.0, 1.2), (620.0, 160.0, 1.4), (1450.0, 320.0, 2.1), (2550.0, 500.0, 1.3)]),
    )

    # Mechanical valvetrain & airbox rush (circular noise)
    breath = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 900.0, 6800.0, order=2.0),
    )
    breath *= 0.12 * (0.75 + 0.25 * np.sin(2.0 * math.pi * f0 * t))
    return _finalize_loop(core + breath, target_rms_dbfs=-14.0)


def synth_eng_v12_5000(rng: np.random.Generator) -> np.ndarray:
    """
    5000 RPM Naturally Aspirated V12:
      Crank = 83.5 Hz (167 cycles / 2 s), dual-bank 6-cyl = 250.0 Hz, firing f0 = 500.0 Hz (1000 cycles / 2 s).
      Soaring F1-style harmonic spacing with gleaming 1.5-3.6 kHz shriek formants.
    """
    dur = 2.0
    n = int(SAMPLE_RATE * dur)
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    f0 = 500.0  # 5000 * 12 / 120
    f_bank = 250.0

    partials: list[tuple[float, float, float]] = [
        (83.5, 0.12, 0.0),
        (167.0, 0.16, 0.9),
        (f_bank, 0.42, 0.3),       # classic 6-per-bank undertone
        (f_bank * 3.0, 0.26, 1.7),  # 750 Hz cross-bank harmonic
        (f_bank * 5.0, 0.16, 2.4),  # 1250 Hz
    ]
    for h in range(1, 18):
        freq = f0 * h
        amp = 1.0 / (h ** 0.88)
        if h in (1, 2, 3, 4, 6):
            amp *= 1.4
        partials.append((freq, amp, float(rng.uniform(0.0, 2.0 * math.pi))))

    core = _harmonic_sum(t, dur, partials)
    lfo = 1.0 + 0.035 * np.sin(2.0 * math.pi * 2.0 * t + 0.4)
    core = np.tanh(core * 0.48) * lfo

    core = _circular_fft_shape(
        core,
        lambda f: _bandpass_curve(f, 75.0, 11500.0, order=2.0)
        * _resonator_bank(f, [(500.0, 120.0, 1.5), (1500.0, 340.0, 2.2), (2850.0, 620.0, 1.7)]),
    )

    intake = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 1400.0, 8500.0, order=2.0),
    )
    intake *= 0.09 * (0.8 + 0.2 * np.sin(2.0 * math.pi * f0 * t))
    return _finalize_loop(core + intake, target_rms_dbfs=-14.0)


def synth_eng_rotary4_6000(rng: np.random.Generator) -> np.ndarray:
    """
    6000 RPM 4-Rotor Wankel (787B-style peripheral-port scream):
      Eccentric shaft = 100.0 Hz, firing f0 = 400.0 Hz (800 cycles / 2 s).
      Sharp pulse-train harmonic density with fierce 1.6-4.5 kHz peripheral-port buzz.
    """
    dur = 2.0
    n = int(SAMPLE_RATE * dur)
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    f0 = 400.0  # 6000 * 4 / 60
    f_shaft = 100.0

    partials: list[tuple[float, float, float]] = [
        (f_shaft, 0.14, 0.0),
        (f_shaft * 2.0, 0.24, 0.6),
        (f_shaft * 3.0, 0.18, 1.4),
    ]
    # Sawtooth/pulse-rich rotary harmonic series
    for h in range(1, 28):
        freq = f0 * h
        amp = 1.0 / (h ** 0.78)
        if h % 2 == 1:
            amp *= 1.18
        partials.append((freq, amp, float(rng.uniform(0.0, 2.0 * math.pi))))
        if h <= 12:
            partials.append((freq + 200.0, amp * 0.22, float(rng.uniform(0.0, 2.0 * math.pi))))

    core = _harmonic_sum(t, dur, partials)
    # Hard asymmetrical peripheral-port pulse clipping
    core = np.tanh(core * 0.72 + 0.12 * (core ** 2) / (1.0 + np.abs(core)))
    core *= 1.0 + 0.04 * np.sin(2.0 * math.pi * 2.5 * t)

    core = _circular_fft_shape(
        core,
        lambda f: _bandpass_curve(f, 95.0, 12500.0, order=2.0)
        * _resonator_bank(f, [(400.0, 90.0, 1.4), (1200.0, 250.0, 1.9), (2400.0, 480.0, 2.4), (4100.0, 750.0, 1.4)]),
    )

    port_hiss = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 2000.0, 10000.0, order=2.0),
    )
    port_hiss *= 0.11 * (0.7 + 0.3 * np.sin(2.0 * math.pi * f0 * t))
    return _finalize_loop(core + port_hiss, target_rms_dbfs=-14.0)


def synth_eng_tt_i6_4000(rng: np.random.Generator) -> np.ndarray:
    """
    4000 RPM Twin-Turbo Inline-6 (RB26 / 2JZ / S58 Tokyo Night signature):
      Even-firing smooth inline-6 fundamental f0 = 200.0 Hz (400 cycles / 2 s),
      warm turbo-muffled mid-bass exhaust body + crisp integrated twin-turbo impeller whistle
      at 3400 Hz & 6800 Hz + pressurized intake rush.
    """
    dur = 2.0
    n = int(SAMPLE_RATE * dur)
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    f0 = 200.0  # 4000 * 6 / 120

    partials: list[tuple[float, float, float]] = [
        (66.5, 0.10, 0.1),
        (133.5, 0.16, 1.2),
    ]
    # Even-firing I6: smooth, slightly warmer rolloff (turbines damp harsh upper odd harmonics)
    for h in range(1, 20):
        freq = f0 * h
        amp = 1.0 / (h ** 1.08)
        if h in (1, 2, 3, 4):
            amp *= 1.45
        partials.append((freq, amp, float(rng.uniform(0.0, 2.0 * math.pi))))

    core = _harmonic_sum(t, dur, partials)
    core = np.tanh(core * 0.50) * (1.0 + 0.03 * np.sin(2.0 * math.pi * 1.0 * t))
    core = _circular_fft_shape(
        core,
        lambda f: _bandpass_curve(f, 50.0, 6200.0, order=2.0)
        * _resonator_bank(f, [(200.0, 55.0, 1.7), (410.0, 110.0, 1.5), (920.0, 240.0, 1.3)]),
    )

    # Twin-turbo spool whine (two slightly detuned impellers: 3400 Hz & 3424 Hz, exact integer cycles)
    fm = 0.25 * np.sin(2.0 * math.pi * 1.5 * t)
    whistle = (
        0.095 * np.sin(2.0 * math.pi * 3400.0 * t + fm)
        + 0.065 * np.sin(2.0 * math.pi * 3424.0 * t - fm + 1.1)
        + 0.035 * np.sin(2.0 * math.pi * 6800.0 * t + 2.0 * fm)
    )
    # Pressurized intercooler / cone-filter air rush
    intake = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 1600.0, 6800.0, order=2.0)
        * _resonator_bank(f, [(3400.0, 550.0, 1.6)]),
    )
    return _finalize_loop(core + whistle + 0.16 * intake, target_rms_dbfs=-14.0)


def synth_eng_sc_v8_whine(rng: np.random.Generator) -> np.ndarray:
    """
    4000 RPM Supercharged Cross-Plane V8 + Roots/Twin-Screw Blower Whine:
      Crank = 66.5 Hz, firing f0 = 266.5 Hz (533 cycles / 2 s).
      Cross-plane half-order rumble (0.5x, 1.5x, 2.5x crank) + commanding supercharger lobe-pass
      whine at 2660 Hz & 5320 Hz with subtle mechanical belt modulation.
    """
    dur = 2.0
    n = int(SAMPLE_RATE * dur)
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    f_crank = 66.5
    f0 = 266.5  # ~4000 * 8 / 120 snapped to 0.5 Hz grid (533 cycles / 2 s)

    partials: list[tuple[float, float, float]] = [
        # Cross-plane V8 rumble sub-orders
        (f_crank * 0.5, 0.20, 0.4),
        (f_crank * 1.0, 0.30, 1.1),
        (f_crank * 1.5, 0.36, 2.0),  # signature cross-plane uneven burble
        (f_crank * 2.0, 0.40, 0.2),
        (f_crank * 2.5, 0.32, 2.7),
        (f_crank * 3.0, 0.28, 1.5),
        (f_crank * 3.5, 0.22, 0.8),
    ]
    for h in range(1, 18):
        freq = f0 * h
        amp = 0.95 / (h ** 0.95)
        if h in (1, 2, 3):
            amp *= 1.35
        partials.append((freq, amp, float(rng.uniform(0.0, 2.0 * math.pi))))

    v8_body = _harmonic_sum(t, dur, partials)
    v8_body = np.tanh(v8_body * 0.62)
    v8_body = _circular_fft_shape(
        v8_body,
        lambda f: _bandpass_curve(f, 35.0, 5800.0, order=2.0)
        * _resonator_bank(f, [(100.0, 45.0, 1.6), (266.5, 75.0, 1.8), (680.0, 180.0, 1.3)]),
    )

    # Prominent twin-screw supercharger lobe-pass whine (exact integer cycles)
    belt_fm = 0.35 * np.sin(2.0 * math.pi * 1.0 * t) + 0.12 * np.sin(2.0 * math.pi * 3.0 * t + 0.7)
    sc_whine = (
        0.48 * np.sin(2.0 * math.pi * 2660.0 * t + belt_fm)
        + 0.22 * np.sin(2.0 * math.pi * 5320.0 * t + 2.0 * belt_fm + 0.5)
        + 0.08 * np.sin(2.0 * math.pi * 7980.0 * t + 3.0 * belt_fm + 1.2)
        + 0.07 * np.sin(2.0 * math.pi * (2660.0 + f_crank) * t + belt_fm)
        + 0.07 * np.sin(2.0 * math.pi * (2660.0 - f_crank) * t + belt_fm)
    )
    sc_air = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 1800.0, 7500.0, order=2.0)
        * _resonator_bank(f, [(2660.0, 400.0, 1.5)]),
    )
    return _finalize_loop(v8_body + 0.55 * sc_whine + 0.12 * sc_air, target_rms_dbfs=-14.0)


# ---- Drivetrain & Induction Synthesizers ---------------------------------------------------------


def synth_gear_whine_straightcut(rng: np.random.Generator) -> np.ndarray:
    """
    2.0 s seamless straight-cut sequential / dogbox gearbox tooth-mesh whine:
      Reference mesh frequency f0 = 1200.0 Hz (2400 cycles / 2 s), shaft runout sidebands ±40 Hz,
      2nd/3rd harmonics (2400 Hz, 3600 Hz), and metallic bearing carrier hiss.
    """
    dur = 2.0
    n = int(SAMPLE_RATE * dur)
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    f_mesh = 1200.0
    f_shaft = 40.0

    # Subtle tooth-runout amplitude & phase modulation (exact integer cycles)
    am = 1.0 + 0.08 * np.sin(2.0 * math.pi * f_shaft * t) + 0.03 * np.sin(2.0 * math.pi * 2.0 * t)
    pm = 0.14 * np.sin(2.0 * math.pi * f_shaft * t + 0.4)

    whine = (
        1.00 * np.sin(2.0 * math.pi * f_mesh * t + pm)
        + 0.52 * np.sin(2.0 * math.pi * (2.0 * f_mesh) * t + 2.0 * pm + 0.7)
        + 0.24 * np.sin(2.0 * math.pi * (3.0 * f_mesh) * t + 3.0 * pm + 1.5)
        + 0.10 * np.sin(2.0 * math.pi * (4.0 * f_mesh) * t + 4.0 * pm + 2.1)
        + 0.16 * np.sin(2.0 * math.pi * (f_mesh - f_shaft) * t + 0.3)
        + 0.16 * np.sin(2.0 * math.pi * (f_mesh + f_shaft) * t + 1.9)
        + 0.12 * np.sin(2.0 * math.pi * 600.0 * t + 0.8)  # half-mesh pinion undertone
    ) * am

    # Gearbox housing resonance & bearing hiss
    whine = _circular_fft_shape(
        whine,
        lambda f: _bandpass_curve(f, 450.0, 9500.0, order=2.0)
        * _resonator_bank(f, [(1200.0, 180.0, 1.4), (2400.0, 320.0, 1.2)]),
    )
    bearing = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 2200.0, 9200.0, order=2.0),
    )
    return _finalize_loop(whine + 0.15 * bearing, target_rms_dbfs=-14.0)


def synth_turbo_flutter_bov(rng: np.random.Generator) -> np.ndarray:
    """
    1.1 s one-shot compressor-surge blow-off valve flutter ("stu-tu-tu-tu"):
      Initial pressurized vent burst followed by 6 decelerating compressor-stall flutter pulses
      modulating band-limited turbulent air + decaying impeller whistle.
    """
    dur = 1.1
    n = int(SAMPLE_RATE * dur)
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE

    # Decelerating flutter phase: rate drops smoothly from ~15 Hz to ~8 Hz
    rate_phase = 2.0 * math.pi * (15.5 * t - 3.6 * (t ** 2))
    # Sharp raised-cosine chop pulses representing reverse air pulses hitting compressor blades
    chop = 0.18 + 0.82 * (0.5 * (1.0 + np.cos(rate_phase))) ** 2.4

    # Overall decay envelope + crisp initial pressure relief spike
    vent_env = np.exp(-t / 0.34)
    initial_burst = 0.85 * np.exp(-((t - 0.028) / 0.026) ** 2)
    env = (vent_env * chop + initial_burst) * np.clip(t / 0.008, 0.0, 1.0)

    # Multi-band turbulent air (crossfade from higher band early to lower band late)
    white = rng.standard_normal(n)
    air_hi = _circular_fft_shape(
        white,
        lambda f: _bandpass_curve(f, 2400.0, 7200.0, order=3.0)
        * _resonator_bank(f, [(3600.0, 600.0, 1.8)]),
    )
    air_mid = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 950.0, 3200.0, order=3.0)
        * _resonator_bank(f, [(1800.0, 380.0, 2.0)]),
    )
    air_lo = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 380.0, 1200.0, order=2.0),
    )

    hi_mix = np.exp(-t / 0.22)
    mid_mix = 1.0 - 0.35 * hi_mix
    air = (0.75 * hi_mix * air_hi + 1.0 * mid_mix * air_mid + 0.45 * air_lo) * env

    # Decaying compressor wheel spin-down whistle (5400 Hz -> 2300 Hz)
    f_whistle = 2300.0 + 3100.0 * np.exp(-t / 0.35)
    phi_whistle = 2.0 * math.pi * np.cumsum(f_whistle) / SAMPLE_RATE
    whistle = (0.20 * np.sin(phi_whistle) + 0.07 * np.sin(2.0 * phi_whistle)) * env * np.exp(-t / 0.42)

    return _finalize_oneshot(air + whistle, target_rms_dbfs=-14.0, fade_in_ms=4.0, fade_out_ms=60.0)


def synth_exhaust_backfire_pop(rng: np.random.Generator) -> np.ndarray:
    """
    0.55 s one-shot overrun exhaust detonation / shift-cut bang:
      Punchy sub-mid pressure shock + broadband crack + secondary overrun crackle at 95 ms
      + damped exhaust pipe resonance (110 Hz, 235 Hz, 410 Hz).
    """
    dur = 0.55
    n = int(SAMPLE_RATE * dur)
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE

    # Primary shock transient at t = 8 ms
    t1 = np.maximum(t - 0.008, 0.0)
    gate1 = (t >= 0.008).astype(np.float64)
    f_thump1 = 58.0 + 190.0 * np.exp(-t1 / 0.014)
    phi1 = 2.0 * math.pi * np.cumsum(f_thump1 * gate1) / SAMPLE_RATE
    thump1 = np.sin(phi1) * np.exp(-t1 / 0.042) * gate1

    crack1_noise = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 220.0, 7500.0, order=2.0)
        * _resonator_bank(f, [(520.0, 220.0, 1.4), (1650.0, 500.0, 1.3)]),
    )
    crack1 = crack1_noise * np.exp(-t1 / 0.022) * gate1

    # Secondary overrun crackle at t = 102 ms
    t2 = np.maximum(t - 0.102, 0.0)
    gate2 = (t >= 0.102).astype(np.float64)
    f_thump2 = 72.0 + 150.0 * np.exp(-t2 / 0.011)
    phi2 = 2.0 * math.pi * np.cumsum(f_thump2 * gate2) / SAMPLE_RATE
    thump2 = 0.55 * np.sin(phi2) * np.exp(-t2 / 0.032) * gate2
    crack2 = 0.65 * crack1_noise * np.exp(-t2 / 0.018) * gate2

    # Exhaust pipe modal tail + turbulent exhaust roar
    pipe_env = np.exp(-t1 / 0.13) * gate1
    pipe_modes = (
        0.38 * np.sin(2.0 * math.pi * 110.0 * t1)
        + 0.24 * np.sin(2.0 * math.pi * 235.0 * t1 + 0.7)
        + 0.14 * np.sin(2.0 * math.pi * 410.0 * t1 + 1.9)
    ) * pipe_env
    tail_roar = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 80.0, 1400.0, order=2.0),
    ) * (0.45 * np.exp(-t1 / 0.14) * gate1)

    sig = 1.4 * thump1 + 1.6 * crack1 + thump2 + crack2 + pipe_modes + tail_roar
    return _finalize_oneshot(sig, target_rms_dbfs=-14.0, fade_in_ms=2.0, fade_out_ms=70.0)


# ---- Tyre & Road Surface Synthesizers (2.0 s seamless loops) -------------------------------------


def synth_tyre_scrub_dry(rng: np.random.Generator) -> np.ndarray:
    """
    2.0 s seamless dry asphalt tyre slip / squeal loop:
      Organic narrowband stick-slip tread resonances (880 Hz, 1340 Hz, 2150 Hz) combined with
      textured dry rubber-on-asphalt scrub noise and a warm 225 Hz tyre cavity resonance hump.
    """
    dur = 2.0
    n = int(SAMPLE_RATE * dur)
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE

    # Narrowband resonant noise bands for natural non-robotic tyre howl
    squeal_bands = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 650.0, 3200.0, order=2.0)
        * (
            3.2 / (1.0 + ((f - 880.0) / 55.0) ** 2)
            + 2.6 / (1.0 + ((f - 1340.0) / 85.0) ** 2)
            + 1.6 / (1.0 + ((f - 2150.0) / 140.0) ** 2)
        ),
    )
    # Slow organic slip modulation (circular low-frequency envelope)
    mod_raw = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 1.5, 9.0, order=2.0),
    )
    mod = 1.0 + 0.22 * (mod_raw / (float(np.std(mod_raw)) + 1e-9))

    # Subtle coherent stick-slip ridge with micro-FM
    fm1 = 1.8 * np.sin(2.0 * math.pi * 2.5 * t) + 0.9 * np.sin(2.0 * math.pi * 5.5 * t + 1.1)
    fm2 = 2.2 * np.sin(2.0 * math.pi * 3.0 * t + 0.6)
    coherent = (
        0.18 * np.sin(2.0 * math.pi * 880.0 * t + fm1)
        + 0.13 * np.sin(2.0 * math.pi * 1340.0 * t + fm2)
    )

    # Dry asphalt rubber scrub body + 225 Hz toroidal cavity warmth
    scrub = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 160.0, 4800.0, order=2.0)
        * _resonator_bank(f, [(225.0, 40.0, 1.6), (950.0, 350.0, 0.9)]),
    )

    sig = (0.75 * squeal_bands + coherent) * mod + 0.55 * scrub
    return _finalize_loop(sig, target_rms_dbfs=-14.0)


def synth_tyre_spray_wet(rng: np.random.Generator) -> np.ndarray:
    """
    2.0 s seamless wet-asphalt tyre water spray & wheel-arch splash loop:
      Crisp hydro-spray hiss (2.0-12.0 kHz) + turbulent water-channeling mid body (400-1800 Hz)
      + circularly-modulated droplet shimmer (3-12 Hz envelope fluctuations).
    """
    dur = 2.0
    n = int(SAMPLE_RATE * dur)

    # Primary high-frequency hydro-spray hiss
    spray_hi = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 1800.0, 12500.0, order=2.0)
        * _resonator_bank(f, [(3200.0, 1100.0, 1.3), (6800.0, 2200.0, 1.1)]),
    )
    # Turbulent wheel-arch splash body
    splash_mid = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 380.0, 2100.0, order=2.0)
        * _resonator_bank(f, [(820.0, 320.0, 1.2)]),
    )
    # Subtle low-mid puddle rumble + 225 Hz cavity resonance
    puddle_lo = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 120.0, 520.0, order=2.0)
        * _resonator_bank(f, [(225.0, 45.0, 1.1)]),
    )

    # Organic water-channeling shimmer envelopes (mathematically periodic via circular FFT)
    shimmer_hi = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 2.5, 11.0, order=2.0),
    )
    shimmer_hi = 1.0 + 0.24 * (shimmer_hi / (float(np.std(shimmer_hi)) + 1e-9))

    shimmer_mid = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 1.5, 7.5, order=2.0),
    )
    shimmer_mid = 1.0 + 0.28 * (shimmer_mid / (float(np.std(shimmer_mid)) + 1e-9))

    sig = 0.85 * spray_hi * shimmer_hi + 0.65 * splash_mid * shimmer_mid + 0.30 * puddle_lo
    return _finalize_loop(sig, target_rms_dbfs=-14.0)


def synth_kerb_rumble_strip(rng: np.random.Generator) -> np.ndarray:
    """
    2.0 s seamless kerb / rumble-strip periodic impact loop:
      Reference impact frequency f0 = 32.0 Hz (64 kerb blocks in 2.0 s, ~0.8 m kerb pitch at 92 km/h).
      Each strike excites sub-bass suspension thump, Simcenter ~225 Hz toroidal tyre cavity ring,
      and concrete/asphalt impact grit — circularly wrapped for exact seamless loop continuity.
    """
    dur = 2.0
    n = int(SAMPLE_RATE * dur)
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    f_kerb = 32.0
    num_strikes = int(round(f_kerb * dur))  # 64 exact strikes in 2.0 s
    stride = n / num_strikes  # 1500.0 samples per strike

    # Single kerb-strike impulse response (duration 110 ms, circularly added at each strike)
    ir_len = int(SAMPLE_RATE * 0.11)
    t_ir = np.arange(ir_len, dtype=np.float64) / SAMPLE_RATE
    # 1. Sub-bass suspension block thump (swept 68 Hz -> 34 Hz)
    f_thump = 34.0 + 34.0 * np.exp(-t_ir / 0.012)
    phi_thump = 2.0 * math.pi * np.cumsum(f_thump) / SAMPLE_RATE
    thump = np.sin(phi_thump) * np.exp(-t_ir / 0.026) * np.clip(t_ir / 0.0015, 0.0, 1.0)
    # 2. 225 Hz toroidal tyre cavity resonance ring (matches OpenGrid CavityRingGain)
    cavity = (
        0.52 * np.sin(2.0 * math.pi * 225.0 * t_ir)
        + 0.18 * np.sin(2.0 * math.pi * 450.0 * t_ir + 0.6)
    ) * np.exp(-t_ir / 0.022) * np.clip(t_ir / 0.001, 0.0, 1.0)
    strike_ir = thump + cavity

    # Circularly overlap-add 64 strikes with tiny organic amplitude variation (exact periodic buffer)
    impulses = np.zeros(n, dtype=np.float64)
    grit_env = np.zeros(n, dtype=np.float64)
    ir_idx = np.arange(ir_len)
    grit_pulse = np.exp(-t_ir / 0.009) * np.clip(t_ir / 0.0008, 0.0, 1.0)

    for k in range(num_strikes):
        start = int(round(k * stride))
        amp_var = 0.90 + 0.20 * float(rng.uniform(0.0, 1.0))
        dest = (start + ir_idx) % n
        impulses[dest] += amp_var * strike_ir
        grit_env[dest] += amp_var * grit_pulse

    # Concrete / painted-kerb contact grit synchronized to every strike
    grit_noise = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 280.0, 2200.0, order=2.0)
        * _resonator_bank(f, [(225.0, 35.0, 1.3), (780.0, 260.0, 1.1)]),
    )
    # Reinforce fundamental kerb buzz (32/64/96 Hz exact integer cycles)
    hum = _harmonic_sum(t, dur, [(32.0, 0.28, 0.0), (64.0, 0.22, 0.4), (96.0, 0.12, 1.1)])
    sig = impulses + 0.42 * grit_noise * grit_env + hum
    return _finalize_loop(sig, target_rms_dbfs=-14.0)


STEM_SPECS: list[StemSpec] = [
    StemSpec(
        stem_id="eng_flat6_4000",
        filename="eng_flat6_4000.wav",
        category="engine",
        description="4000 RPM Flat-6 boxer exhaust & intake loop (GT3 RS / Kestrel GT reference)",
        loop=True,
        duration_s=2.0,
        reference_rpm=4000,
        fundamental_hz=200.0,
        synth_fn=synth_eng_flat6_4000,
    ),
    StemSpec(
        stem_id="eng_v12_5000",
        filename="eng_v12_5000.wav",
        category="engine",
        description="5000 RPM naturally aspirated V12 high-revving exotic exhaust loop",
        loop=True,
        duration_s=2.0,
        reference_rpm=5000,
        fundamental_hz=500.0,
        synth_fn=synth_eng_v12_5000,
    ),
    StemSpec(
        stem_id="eng_rotary4_6000",
        filename="eng_rotary4_6000.wav",
        category="engine",
        description="6000 RPM 4-rotor peripheral-port Wankel exhaust loop",
        loop=True,
        duration_s=2.0,
        reference_rpm=6000,
        fundamental_hz=400.0,
        synth_fn=synth_eng_rotary4_6000,
    ),
    StemSpec(
        stem_id="eng_tt_i6_4000",
        filename="eng_tt_i6_4000.wav",
        category="engine",
        description="4000 RPM Twin-Turbo Inline-6 exhaust + twin-impeller spool loop",
        loop=True,
        duration_s=2.0,
        reference_rpm=4000,
        fundamental_hz=200.0,
        synth_fn=synth_eng_tt_i6_4000,
    ),
    StemSpec(
        stem_id="eng_sc_v8_whine",
        filename="eng_sc_v8_whine.wav",
        category="engine",
        description="4000 RPM Supercharged cross-plane V8 rumble + twin-screw blower whine loop",
        loop=True,
        duration_s=2.0,
        reference_rpm=4000,
        fundamental_hz=266.5,
        synth_fn=synth_eng_sc_v8_whine,
    ),
    StemSpec(
        stem_id="gear_whine_straightcut",
        filename="gear_whine_straightcut.wav",
        category="drivetrain_induction",
        description="Straight-cut sequential dogbox tooth-mesh whine loop (reference 1200 Hz mesh)",
        loop=True,
        duration_s=2.0,
        reference_rpm=None,
        fundamental_hz=1200.0,
        synth_fn=synth_gear_whine_straightcut,
    ),
    StemSpec(
        stem_id="turbo_flutter_bov",
        filename="turbo_flutter_bov.wav",
        category="drivetrain_induction",
        description="One-shot compressor-surge blow-off valve flutter (stu-tu-tu-tu)",
        loop=False,
        duration_s=1.1,
        reference_rpm=None,
        fundamental_hz=1800.0,
        synth_fn=synth_turbo_flutter_bov,
    ),
    StemSpec(
        stem_id="exhaust_backfire_pop",
        filename="exhaust_backfire_pop.wav",
        category="drivetrain_induction",
        description="One-shot overrun unburnt-fuel exhaust detonation & shift-cut pop",
        loop=False,
        duration_s=0.55,
        reference_rpm=None,
        fundamental_hz=110.0,
        synth_fn=synth_exhaust_backfire_pop,
    ),
    StemSpec(
        stem_id="tyre_scrub_dry",
        filename="tyre_scrub_dry.wav",
        category="tyre_surface",
        description="Dry asphalt tyre stick-slip squeal + 225 Hz cavity resonance loop",
        loop=True,
        duration_s=2.0,
        reference_rpm=None,
        fundamental_hz=880.0,
        synth_fn=synth_tyre_scrub_dry,
    ),
    StemSpec(
        stem_id="tyre_spray_wet",
        filename="tyre_spray_wet.wav",
        category="tyre_surface",
        description="Wet asphalt tyre hydro-spray hiss + turbulent wheel-arch splash loop",
        loop=True,
        duration_s=2.0,
        reference_rpm=None,
        fundamental_hz=3200.0,
        synth_fn=synth_tyre_spray_wet,
    ),
    StemSpec(
        stem_id="kerb_rumble_strip",
        filename="kerb_rumble_strip.wav",
        category="tyre_surface",
        description="Track kerb rumble-strip 32 Hz impact pulse + 225 Hz tyre cavity ring loop",
        loop=True,
        duration_s=2.0,
        reference_rpm=None,
        fundamental_hz=32.0,
        synth_fn=synth_kerb_rumble_strip,
    ),
]


# ---- 24-bit PCM WAV I/O --------------------------------------------------------------------------


def write_wav_24bit_mono(path: Path, samples: np.ndarray, sr: int = SAMPLE_RATE) -> None:
    """Write mono float64 samples in [-1, 1] as 48 kHz / 24-bit signed little-endian PCM WAV."""
    clipped = np.clip(samples, -1.0, 1.0)
    scaled = np.rint(clipped * 8388607.0).astype(np.int32)
    raw = scaled.view("<u1").reshape(-1, 4)[:, :3].tobytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(BIT_DEPTH // 8)
        wf.setframerate(sr)
        wf.writeframes(raw)


def read_wav_24bit_mono(path: Path) -> tuple[dict[str, int | str], np.ndarray]:
    """Read a 24-bit PCM WAV file and return (header_info, float64_samples in [-1, 1])."""
    with wave.open(str(path), "rb") as wf:
        info: dict[str, int | str] = {
            "channels": wf.getnchannels(),
            "sampwidth": wf.getsampwidth(),
            "sample_rate": wf.getframerate(),
            "nframes": wf.getnframes(),
            "comptype": wf.getcomptype(),
        }
        raw = wf.readframes(int(info["nframes"]))
    if info["sampwidth"] != 3:
        raise ValueError(f"{path.name}: expected 24-bit (sampwidth=3), got sampwidth={info['sampwidth']}")
    u8 = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
    buf = np.zeros((u8.shape[0], 4), dtype=np.uint8)
    buf[:, 1:4] = u8
    i32 = buf.view("<i4").ravel() >> 8
    return info, i32.astype(np.float64) / 8388608.0


def measure_stem(samples: np.ndarray) -> dict[str, float]:
    rms = float(np.sqrt(np.mean(samples * samples)))
    rms_dbfs = 20.0 * math.log10(max(rms, 1e-12))
    peak = float(np.max(np.abs(samples)))
    boundary_delta = float(abs(samples[-1] - samples[0]))
    return {
        "rms_dbfs": round(rms_dbfs, 3),
        "peak_linear": round(peak, 5),
        "boundary_delta": round(boundary_delta, 6),
    }


def generate_all(audio_dir: Path, manifest_path: Path) -> None:
    audio_dir.mkdir(parents=True, exist_ok=True)
    manifest_stems: list[dict[str, object]] = []

    for idx, spec in enumerate(STEM_SPECS):
        # Deterministic per-stem seed so re-runs are bit-reproducible
        rng = np.random.default_rng(20261121 + idx * 9973)
        samples = spec.synth_fn(rng)
        wav_path = audio_dir / spec.filename
        write_wav_24bit_mono(wav_path, samples, SAMPLE_RATE)

        # Measure exact quantized 24-bit file
        _, decoded = read_wav_24bit_mono(wav_path)
        stats = measure_stem(decoded)
        manifest_stems.append(
            {
                "id": spec.stem_id,
                "filename": spec.filename,
                "relative_wav_path": f"ue5/Import/Audio/{spec.filename}",
                "category": spec.category,
                "description": spec.description,
                "loop": spec.loop,
                "sample_rate_hz": SAMPLE_RATE,
                "bit_depth": BIT_DEPTH,
                "channels": CHANNELS,
                "duration_s": round(decoded.shape[0] / SAMPLE_RATE, 4),
                "num_frames": int(decoded.shape[0]),
                "reference_rpm": spec.reference_rpm,
                "fundamental_hz": spec.fundamental_hz,
                "rms_dbfs": stats["rms_dbfs"],
                "peak_linear": stats["peak_linear"],
                "boundary_delta": stats["boundary_delta"],
                "license": STEM_LICENSE,
            }
        )
        print(
            f"Wrote {wav_path.name:28s} "
            f"({decoded.shape[0] / SAMPLE_RATE:4.2f}s, f0={spec.fundamental_hz:6.1f}Hz, "
            f"rms={stats['rms_dbfs']:6.2f}dBFS, peak={stats['peak_linear']:.3f}, "
            f"|end-start|={stats['boundary_delta']:.5f})"
        )

    manifest = {
        "schema_version": 1,
        "generator": "tools/ue5/generate_audio_stems.py",
        "license": STEM_LICENSE,
        "provenance": PROVENANCE,
        "sample_rate_hz": SAMPLE_RATE,
        "bit_depth": BIT_DEPTH,
        "channels": CHANNELS,
        "output_dir": "ue5/Import/Audio",
        "stem_count": len(manifest_stems),
        "stems": manifest_stems,
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote manifest: {manifest_path}")


def verify_all(audio_dir: Path, manifest_path: Path) -> None:
    errors: list[str] = []

    if not manifest_path.is_file():
        raise AssertionError(f"Missing manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("license") != STEM_LICENSE:
        errors.append(f"Manifest license mismatch: {manifest.get('license')!r}")
    if manifest.get("sample_rate_hz") != SAMPLE_RATE or manifest.get("bit_depth") != BIT_DEPTH:
        errors.append("Manifest sample_rate_hz / bit_depth mismatch")

    manifest_by_id = {entry["id"]: entry for entry in manifest.get("stems", [])}
    if len(manifest_by_id) != len(STEM_SPECS):
        errors.append(f"Manifest stem count {len(manifest_by_id)} != expected {len(STEM_SPECS)}")

    for spec in STEM_SPECS:
        wav_path = audio_dir / spec.filename
        if not wav_path.is_file():
            errors.append(f"Missing WAV stem: {wav_path}")
            continue
        if spec.stem_id not in manifest_by_id:
            errors.append(f"Missing manifest entry for {spec.stem_id}")

        info, samples = read_wav_24bit_mono(wav_path)
        if info["sample_rate"] != SAMPLE_RATE:
            errors.append(f"{spec.filename}: sample_rate {info['sample_rate']} != {SAMPLE_RATE}")
        if info["sampwidth"] != 3:
            errors.append(f"{spec.filename}: sampwidth {info['sampwidth']} != 3 (24-bit)")
        if info["channels"] != CHANNELS:
            errors.append(f"{spec.filename}: channels {info['channels']} != {CHANNELS}")
        if info["comptype"] != "NONE":
            errors.append(f"{spec.filename}: comptype {info['comptype']} != 'NONE'")
        expected_frames = int(round(spec.duration_s * SAMPLE_RATE))
        if info["nframes"] != expected_frames:
            errors.append(f"{spec.filename}: nframes {info['nframes']} != {expected_frames}")

        stats = measure_stem(samples)
        if not (-24.0 <= stats["rms_dbfs"] <= -6.0):
            errors.append(f"{spec.filename}: RMS {stats['rms_dbfs']:.2f} dBFS outside [-24, -6] dBFS")
        if stats["peak_linear"] > 0.99:
            errors.append(f"{spec.filename}: peak {stats['peak_linear']:.4f} > 0.99 (clipping)")
        if stats["boundary_delta"] >= 0.02:
            errors.append(f"{spec.filename}: |end - start| = {stats['boundary_delta']:.5f} >= 0.02")

        # Additional NaN / Inf guard
        if not np.all(np.isfinite(samples)):
            errors.append(f"{spec.filename}: contains NaN or Inf")

    if errors:
        print("FAILED MetaSound audio stem verification:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        sys.exit(1)

    print(
        f"PASS MetaSound audio stem verification "
        f"({len(STEM_SPECS)} stems, 48 kHz / 24-bit PCM WAV, RMS in [-24, -6] dBFS, "
        f"peak <= 0.99, |end - start| < 0.02)"
    )


def main() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(
        description="Generate 48 kHz / 24-bit seamless MetaSound WAV stems for UE 5.8."
    )
    parser.add_argument(
        "--audio-dir",
        type=Path,
        default=repo_root / "ue5" / "Import" / "Audio",
        help="Output WAV directory (default: ue5/Import/Audio)",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=repo_root / "assets_source" / "audio" / "manifest.json",
        help="Output manifest JSON path (default: assets_source/audio/manifest.json)",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Run automated DSP/header/loop verification after generation",
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Verify existing WAV stems and manifest without regenerating",
    )
    args = parser.parse_args()

    if not args.verify_only:
        generate_all(args.audio_dir, args.manifest)

    if args.verify or args.verify_only:
        verify_all(args.audio_dir, args.manifest)


if __name__ == "__main__":
    main()
