#!/usr/bin/env python3
"""
Apache-2.0 — Procedural 48 kHz / 24-bit PCM WAV + WebGPU Vorbis OGG audio stem generator
for OpenGrid (UE 5.8 + WebGPU).

Synthesizes 37 Forza Horizon 6-grade, dyno-smooth automotive audio stems using 100% original
procedural DSP (physical cylinder-by-cylinder blowdown pulse-trains, dual-bank exhaust header
waveguides, broad dry-ish Helmholtz formants for stationary fixed-formant sweeping, sub-bass
chest punch, high-order metallic valvetrain sheen, choked-flow exhaust turbulence roar, and
asymmetric shock saturation; zero third-party samples; output licence CC-BY-NC-4.0):

  4-Zone Engine Loops (30 stems, 1.5 s exact integer-cycle seamless loops):
    - Flat-6 NA (GT3 RS):        eng_flat6_1000, eng_flat6_low, eng_flat6_4000, eng_flat6_7800
    - V12 NA (Daytona SP3):      eng_v12_1000, eng_v12_low, eng_v12_5000, eng_v12_8000
    - V10 Screamer (Huracán):    eng_v10_1000, eng_v10_low, eng_v10_5500, eng_v10_7800
    - 4-Rotor Bridge-Port:       eng_rotary4_1100, eng_rotary4_low, eng_rotary4_6000, eng_rotary4_8500
    - Forged TT I6 / V6 (R34):   eng_tt_i6_1000, eng_tt_i6_low, eng_tt_i6_4000, eng_tt_i6_7000
    - Cross-Plane V8 (Muscle):   eng_v8_cross_900, eng_v8_cross_low, eng_v8_cross_4200, eng_v8_cross_6800
    - Flat-Plane V8 (Fiamma):    eng_v8_flat_1100, eng_v8_flat_low, eng_v8_flat_5500, eng_v8_flat_8000
    - Supercharged V8:           eng_sc_v8_whine, eng_sc_v8_6800

  Visceral Drivetrain, Forced-Induction, Exhaust & Tyre FX Stems (7 stems):
    - turbo_spool_loop.wav       (1.5 s loop, Garrett/BorgWarner compressor wheel whistle + charge-pipe rush)
    - turbo_flutter_bov.wav      (1.1 s one-shot, crisp loud 6-pulse stu-tu-tu-tu-tu-tu + Al pipe ring)
    - exhaust_backfire_pop.wav   (0.55 s one-shot, shotgun bang + sub-bass shockwave + double-crackle tail)
    - gear_whine_straightcut.wav (1.5 s loop, GT3 sequential straight-cut transmission whine)
    - tyre_scrub_dry.wav         (1.5 s loop, multi-harmonic sticky semi-slick rubber squeal/howl)
    - tyre_spray_wet.wav         (1.5 s loop, wet asphalt hydroplane spray hiss + wheel-arch splashes)
    - kerb_rumble_strip.wav      (1.5 s loop, heavy hollow 32 Hz kerb block thumps + tyre cavity boom)

Outputs:
  - `ue5/Import/Audio/*.wav`            (gitignored 48 kHz / 24-bit mono PCM WAV stems for UE 5.8)
  - `web/public/assets/audio/*.ogg`     (compact libvorbis -q:a 5 OGG stems for WebGPU)
  - `assets_source/audio/manifest.json` (tracked metadata & provenance ledger)

Usage:
  python3 tools/ue5/generate_audio_stems.py
  python3 tools/ue5/generate_audio_stems.py --verify
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np

SAMPLE_RATE = 48000
BIT_DEPTH = 24
CHANNELS = 1
LOOP_DURATION_S = 1.5
STEM_LICENSE = "CC-BY-NC-4.0"
PROVENANCE = (
    "100% original procedural physical combustion & waveguide DSP synthesis (OpenGrid) "
    "— zero third-party samples"
)


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


@dataclass(frozen=True)
class CylinderEvent:
    """One cylinder firing slot inside a single thermodynamic cycle."""

    angle_deg: float
    bank: int  # 0 = Left/Front bank, 1 = Right/Rear bank
    runner_delay_ms: float = 0.0
    amp_trim: float = 1.0


def _formant_q(center_hz: float, q: float, gain: float) -> tuple[float, float, float]:
    """Build a broad Lorentzian formant tuple (center_hz, half_bw_hz, gain) with exact Q = fc / (2 * bw)."""
    return (center_hz, center_hz / (2.0 * max(0.5, q)), gain)


@dataclass(frozen=True)
class EnginePhysConfig:
    """Physical combustion pulse-train + dual-bank exhaust waveguide parameters."""

    rpm: float
    cycle_deg: float  # 720.0 for 4-stroke, 360.0 for Wankel rotary
    cylinders: tuple[CylinderEvent, ...]
    # Whether firing pattern is symmetric per L/R bank pair (allows ultra-accurate RPM snapping)
    bank_symmetric: bool = True
    # Blowdown pressure impulse: (t/tau)^exp * exp(-t/tau) + shock_front - rarefaction
    blowdown_tau_ms: float = 1.0
    blowdown_exp: float = 1.24
    shock_mix: float = 0.72  # supersonic valve-crack shock front for upper-mid harmonic bite
    rarefaction_depth: float = 0.34
    rarefaction_tau_mult: float = 2.40
    rarefaction_delay_mult: float = 1.12
    # Physical tailpipe acoustic radiation tilt (+6 dB/oct volume-velocity -> far-field pressure)
    rad_corner_hz: float = 1900.0
    rad_tilt_exp: float = 1.08
    # Tight, organic cycle-to-cycle variation (CCV) — zero hiccups when pitched down!
    energy_jitter_frac: float = 0.035  # 2.5-4.5% smooth dyno-grade CCV
    time_jitter_ms: float = 0.12  # 0.08-0.18 ms subtle micro-jitter
    tau_jitter_frac: float = 0.032
    # Optional periodic multi-cycle firing amplitude modulation (e.g. bridge-port BRAP)
    supercycle_pattern: tuple[float, ...] | None = None
    # Dual-bank exhaust header waveguide delays & open-end comb reflections
    bank0_delay_ms: float = 1.5
    bank1_delay_ms: float = 2.2
    pipe0_tau_ms: float = 3.2
    pipe1_tau_ms: float = 3.5
    pipe_fwd_gain: float = 0.30
    pipe_fb_gain: float = 0.28  # kept dry-ish so stationary Web Audio formants sweep cleanly
    pipe_damp_hz: float = 4800.0
    xpipe_mix: float = 0.22
    xpipe_delay_ms: float = 0.85
    # Choked-flow exhaust turbulence roar locked to blowdown gas velocity
    rasp_gain: float = 0.32
    rasp_lo_hz: float = 320.0
    rasp_hi_hz: float = 4800.0
    crackle_gain: float = 0.20
    crackle_lo_hz: float = 2200.0
    crackle_hi_hz: float = 11200.0
    # Broad, dry-ish muffler/header spectral contour (Q ~ 1.0-1.8)
    band_lo_hz: float = 36.0
    band_hi_hz: float = 11500.0
    exhaust_formants: tuple[tuple[float, float, float], ...] = ()
    # Intake plenum / ITB roar
    intake_gain: float = 0.24
    intake_tau_mult: float = 1.75
    intake_angle_offset_deg: float = -210.0
    intake_formants: tuple[tuple[float, float, float], ...] = (
        _formant_q(260.0, 1.3, 0.85),
        _formant_q(880.0, 1.4, 0.85),
    )
    intake_rush_gain: float = 0.09
    intake_rush_band: tuple[float, float] = (950.0, 6800.0)
    # Mechanical valvetrain / crankcase metallic sheen (2.5-6.5 kHz high-order harmonics + friction)
    mech_gain: float = 0.068
    mech_band: tuple[float, float] = (2500.0, 6800.0)
    # Sub-bass chest punch (fundamental + half-order crank throb at 45-110 Hz)
    sub_punch_gain: float = 0.26
    sub_bass_boost_hz: float = 72.0
    sub_bass_gain: float = 0.35
    # Asymmetric tube / titanium shockwave saturation
    sat_drive: float = 1.75
    sat_asym: float = 0.13
    # Broad post-saturation polish
    post_formants: tuple[tuple[float, float, float], ...] = ()
    # Target RMS
    target_rms_dbfs: float = -13.0


# ---- Core Periodic DSP Primitives ----------------------------------------------------------------


def _nyquist_taper_arr(freqs: np.ndarray, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Smooth raised-cosine Nyquist rolloff above 0.40*sr for zero aliasing."""
    lo = 0.40 * sr
    hi = 0.46 * sr
    t = np.clip((freqs - lo) / (hi - lo), 0.0, 1.0)
    return 0.5 * (1.0 + np.cos(math.pi * t))


def _exact_cycle_freq(freq_hz: float, duration_s: float) -> float:
    """Snap frequency to exact integer number of cycles over duration_s."""
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
    lo = 0.40 * sr
    hi = 0.46 * sr
    for freq, amp, phase in partials:
        if freq <= 0.0 or amp == 0.0:
            continue
        f_exact = _exact_cycle_freq(freq, duration_s)
        if f_exact >= hi:
            continue
        taper = 1.0 if f_exact <= lo else 0.5 * (1.0 + math.cos(math.pi * (f_exact - lo) / (hi - lo)))
        out += (amp * taper) * np.sin(two_pi * f_exact * t + phase)
    return out


def _circular_fft_shape(
    x: np.ndarray,
    response_fn: Callable[[np.ndarray], np.ndarray],
    sr: int = SAMPLE_RATE,
) -> np.ndarray:
    """Apply a real or complex frequency response via rFFT/irFFT (100% periodic on [0, N))."""
    n = x.shape[0]
    freqs = np.fft.rfftfreq(n, d=1.0 / sr)
    spec = np.fft.rfft(x)
    resp = np.asarray(response_fn(freqs))
    resp = resp * _nyquist_taper_arr(freqs, sr)
    resp[0] = 0.0
    if n % 2 == 0:
        resp[-1] = 0.0
    return np.fft.irfft(spec * resp, n=n)


def _bandpass_curve(freqs: np.ndarray, f_lo: float, f_hi: float, order: float = 3.0) -> np.ndarray:
    """Smooth Butterworth-like magnitude bandpass curve."""
    f_safe = np.maximum(freqs, 1e-6)
    hp = 1.0 / np.sqrt(1.0 + (f_lo / f_safe) ** (2.0 * order))
    lp = 1.0 / np.sqrt(1.0 + (f_safe / f_hi) ** (2.0 * order))
    return hp * lp


def _resonator_bank(
    freqs: np.ndarray,
    formants: tuple[tuple[float, float, float], ...] | list[tuple[float, float, float]],
) -> np.ndarray:
    """Sum of Lorentzian Helmholtz / pipe formant peaks: (center_hz, half_bw_hz, gain)."""
    h = np.ones_like(freqs, dtype=np.float64)
    for fc, bw, g in formants:
        h += g / (1.0 + ((freqs - fc) / bw) ** 2)
    return h


def _waveguide_pipe_tf(
    freqs: np.ndarray,
    delay_ms: float,
    pipe_tau_ms: float,
    fwd_gain: float,
    fb_gain: float,
    damp_hz: float,
) -> np.ndarray:
    """
    Complex circularly-periodic transfer function of a physical exhaust primary/collector pipe:
      propagation delay + damped open-end reflection comb + natural resonant pipe modes.
    """
    two_pi = 2.0 * math.pi
    d_sec = delay_ms * 1e-3
    tau_sec = pipe_tau_ms * 1e-3
    wall_damp = 1.0 / np.sqrt(1.0 + (freqs / damp_hz) ** 2)
    z_delay = np.exp(-1j * two_pi * freqs * d_sec)
    z_pipe = np.exp(-1j * two_pi * freqs * tau_sec)
    num = 1.0 - fwd_gain * wall_damp * z_pipe
    den = 1.0 - fb_gain * wall_damp * (z_pipe ** 2)
    return z_delay * (num / den)


def _tailpipe_radiation_curve(
    freqs: np.ndarray,
    corner_hz: float = 1900.0,
    tilt_exp: float = 1.08,
) -> np.ndarray:
    """
    Physical open-tailpipe acoustic radiation impedance: far-field pressure p_rad ~ dU/dt
    gives an upward tilt from bass up to pipe cutoff f_c = c/(pi*d), converting volume-velocity
    blowdown pulses into raw dyno-microphone acoustic pressure.
    """
    f_safe = np.maximum(freqs, 1.0)
    return (f_safe / np.sqrt(f_safe * f_safe + corner_hz * corner_hz)) ** tilt_exp


def _asymmetric_saturate(
    x: np.ndarray,
    drive: float = 1.75,
    asym: float = 0.13,
    dry_mix: float = 0.24,
) -> np.ndarray:
    """
    Warm asymmetric tube / titanium exhaust-shock saturation (DC-removed, memoryless -> periodic).
    Adds phase-locked even + odd harmonic richness while preserving natural blowdown crest factor.
    """
    rms = float(np.sqrt(np.mean(x * x)))
    if rms < 1e-12:
        return x
    xn = x / (rms * 2.85)
    wet = np.tanh(drive * (xn + asym)) - math.tanh(drive * asym)
    wet = wet + 0.18 * np.tanh(drive * 1.55 * xn)
    y = (1.0 - dry_mix) * wet + dry_mix * xn
    return y - float(np.mean(y))


def _soft_limit(x: np.ndarray, threshold: float = 0.84, ceiling: float = 0.94) -> np.ndarray:
    """Smooth memoryless soft limiter preserving loop periodicity."""
    peak = float(np.max(np.abs(x)))
    if peak <= threshold:
        return x
    abs_x = np.abs(x)
    over = np.maximum(abs_x - threshold, 0.0)
    headroom = ceiling - threshold
    return np.where(
        abs_x > threshold,
        np.sign(x) * (threshold + headroom * np.tanh(over / headroom)),
        x,
    )


def _align_loop_boundary(x: np.ndarray) -> np.ndarray:
    """
    Circularly rotate a periodic loop to the cleanest boundary point where both
    |x[i] - x[i-1]| and |x[i]| are minimal, guaranteeing zero click and |end - start| << 0.02.
    """
    prev = np.roll(x, 1)
    step = np.abs(x - prev)
    score = step + 0.30 * np.abs(x)
    best = int(np.argmin(score))
    return np.roll(x, -best)


def _finalize_loop(x: np.ndarray, target_rms_dbfs: float = -13.0) -> np.ndarray:
    """Remove DC, normalize to target RMS, soft-limit, and align loop seam."""
    y = x - float(np.mean(x))
    rms = float(np.sqrt(np.mean(y * y)))
    if rms > 1e-12:
        target_rms = 10.0 ** (target_rms_dbfs / 20.0)
        y = y * (target_rms / rms)
    y = _soft_limit(y, threshold=0.83, ceiling=0.94)
    y = y - float(np.mean(y))
    peak = float(np.max(np.abs(y)))
    if peak > 0.96:
        y = y * (0.95 / peak)
    return _align_loop_boundary(y)


def _finalize_oneshot(
    x: np.ndarray,
    target_rms_dbfs: float = -12.5,
    fade_in_ms: float = 2.0,
    fade_out_ms: float = 55.0,
    sr: int = SAMPLE_RATE,
) -> np.ndarray:
    """High-pass DC, fade cleanly to zero at both ends, normalize RMS, soft-limit."""
    y = _circular_fft_shape(x, lambda f: _bandpass_curve(f, 22.0, 19500.0, order=2.0), sr)
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
    y = _soft_limit(y, threshold=0.83, ceiling=0.95)
    y[0] = 0.0
    y[-1] = 0.0
    return y


# ---- Physical Cylinder-by-Cylinder Combustion + Exhaust Waveguide Engine -------------------------


def _scatter_blowdown_pulse(
    buf_wave: np.ndarray,
    buf_turb: np.ndarray,
    event_sample: float,
    amp: float,
    tau_s: float,
    exp_rise: float,
    shock_mix: float,
    rarefaction_depth: float,
    rarefaction_tau_s: float,
    rarefaction_delay_s: float,
    sr: int = SAMPLE_RATE,
) -> None:
    """
    Circularly scatter-add one sub-sample-accurate physical blowdown pressure impulse:
      p(t) = bulk blowdown + valve-crack shock front + port-edge harmonic transient - rarefaction
    along with its unipolar gas-velocity turbulence envelope.
    """
    n = buf_wave.shape[0]
    s0 = int(math.floor(event_sample))
    frac = event_sample - s0

    win = min(n, max(64, int(math.ceil((rarefaction_delay_s + 9.5 * rarefaction_tau_s) * sr)) + 4))
    k = np.arange(win, dtype=np.int64)
    dt = (k.astype(np.float64) - frac) / sr
    dt_pos = np.maximum(dt, 0.0)

    # Positive bulk cylinder blowdown wave normalized to unit peak
    u = dt_pos / tau_s
    norm_pos = (math.e / exp_rise) ** exp_rise
    p_pos = (u ** exp_rise) * np.exp(-u) * norm_pos

    # Supersonic choked-flow valve-crack shock front + crisp exhaust-port leading edge
    if shock_mix > 0.0:
        tau_shock = max(0.00011, tau_s * 0.20)
        us = dt_pos / tau_shock
        norm_s = (math.e / 1.12) ** 1.12
        p_shock = shock_mix * (us ** 1.12) * np.exp(-us) * norm_s

        tau_edge = max(0.000075, tau_s * 0.105)
        ue = dt_pos / tau_edge
        p_edge = (0.22 * shock_mix) * ue * np.exp(-ue) * math.e
    else:
        p_shock = 0.0
        p_edge = 0.0

    # Negative scavenging rarefaction trough normalized to unit peak
    dt_r = np.maximum(dt - rarefaction_delay_s, 0.0)
    v = dt_r / rarefaction_tau_s
    norm_neg = (math.e / 1.5) ** 1.5
    p_neg = rarefaction_depth * (v ** 1.5) * np.exp(-v) * norm_neg

    # Gas-velocity turbulence burst peaks slightly after shock front
    u_t = dt_pos / (tau_s * 1.32)
    turb = (u_t ** 1.1) * np.exp(-u_t) * ((math.e / 1.1) ** 1.1)

    dest = (s0 + k) % n
    buf_wave[dest] += amp * (p_pos + p_shock + p_edge - p_neg)
    buf_turb[dest] += abs(amp) * turb


def _synth_physical_engine(
    cfg: EnginePhysConfig,
    rng: np.random.Generator,
    duration_s: float = LOOP_DURATION_S,
    extra_layer_fn: Callable[[np.ndarray, float, float, np.random.Generator], np.ndarray] | None = None,
) -> np.ndarray:
    """
    Synthesize a mathematically periodic 1.5 s Forza Horizon 6-grade physical combustion +
    dual-bank exhaust waveguide engine loop:
      - Tight 2.5-4.5% cycle-to-cycle amplitude variation & 0.08-0.18 ms timing micro-jitter
        for butter-smooth dyno sweeps with ZERO low-RPM hiccups.
      - Exact bank-pair pitch snapping so multi-zone RPM crossfades stay dead in tune.
      - Broad dry-ish formants (Q ~ 1.0-1.8) so stationary Web Audio exhaust/muffler formants
        sweep harmonics organically.
      - Dedicated 45-110 Hz sub-bass chest punch + 2.5-6.5 kHz mechanical valvetrain metallic sheen
        + choked-flow wideband exhaust turbulence roar.
    """
    n = int(round(SAMPLE_RATE * duration_s))
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE

    n_cyl = len(cfg.cylinders)
    cycles_per_sec_nom = (cfg.rpm / 60.0) * (360.0 / cfg.cycle_deg)
    cycles_nom = cycles_per_sec_nom * duration_s

    # Choose full thermodynamic cycle vs bank-symmetric L+R pair snapping for ultra-accurate RPM
    use_pair_snap = (
        cfg.bank_symmetric
        and cfg.supercycle_pattern is None
        and n_cyl >= 2
        and (n_cyl % 2 == 0)
        and abs(cycles_nom - round(cycles_nom)) > 0.05
    )

    if use_pair_snap:
        pairs_per_cycle = n_cyl // 2
        n_groups = max(1, int(round(cycles_nom * pairs_per_cycle)))
        group_cyls = cfg.cylinders[:2]
        group_deg = cfg.cycle_deg / pairs_per_cycle
        group_dur_s = duration_s / n_groups
        f_fire = (n_groups * 2.0) / duration_s
        f_crank = f_fire / (n_cyl * (360.0 / cfg.cycle_deg))
    else:
        n_groups = max(1, int(round(cycles_nom)))
        if cfg.supercycle_pattern is not None:
            pat_len = len(cfg.supercycle_pattern)
            cycles_per_pat = max(1, pat_len // max(1, n_cyl))
            n_groups = max(cycles_per_pat, int(round(n_groups / cycles_per_pat)) * cycles_per_pat)
        group_cyls = cfg.cylinders
        group_deg = cfg.cycle_deg
        group_dur_s = duration_s / n_groups
        f_fire = (n_groups * n_cyl) / duration_s
        f_crank = (n_groups / duration_s) * (cfg.cycle_deg / 360.0)

    bank0_raw = np.zeros(n, dtype=np.float64)
    bank1_raw = np.zeros(n, dtype=np.float64)
    turb0 = np.zeros(n, dtype=np.float64)
    turb1 = np.zeros(n, dtype=np.float64)
    intake_raw = np.zeros(n, dtype=np.float64)
    intake_env = np.zeros(n, dtype=np.float64)

    base_tau_s = max(0.00024, cfg.blowdown_tau_ms * 1e-3)
    intake_tau_s = base_tau_s * cfg.intake_tau_mult

    # Subtle per-cylinder mechanical tolerance (tight so no uneven chug/hiccups)
    n_g_cyl = len(group_cyls)
    cyl_static_amp = 1.0 + rng.uniform(-0.022, 0.022, size=n_g_cyl)
    cyl_static_tau = 1.0 + rng.uniform(-0.020, 0.020, size=n_g_cyl)

    firing_idx = 0
    for g in range(n_groups):
        group_t0 = g * group_dur_s
        for idx, cyl in enumerate(group_cyls):
            pat_mult = 1.0
            if cfg.supercycle_pattern is not None:
                pat_mult = cfg.supercycle_pattern[firing_idx % len(cfg.supercycle_pattern)]
            firing_idx += 1

            # Tight, organic cycle-to-cycle combustion energy jitter (2.5-4.5% -> zero hiccups!)
            e_jit = float(np.clip(rng.normal(0.0, cfg.energy_jitter_frac), -0.10, 0.10))
            amp = cyl.amp_trim * cyl_static_amp[idx] * pat_mult * (1.0 + e_jit)

            # Subtle firing-time micro-jitter (0.08-0.18 ms)
            t_jit_ms = float(
                np.clip(
                    rng.normal(0.0, cfg.time_jitter_ms * 0.55),
                    -cfg.time_jitter_ms * 1.25,
                    cfg.time_jitter_ms * 1.25,
                )
            )
            event_t = (
                group_t0
                + (cyl.angle_deg / group_deg) * group_dur_s
                + (cyl.runner_delay_ms + t_jit_ms) * 1e-3
            ) % duration_s

            # Tight pulse-width combustion burn-rate variation
            tau_jit = float(np.clip(rng.normal(1.0, cfg.tau_jitter_frac), 0.91, 1.09))
            tau_i = max(0.00022, base_tau_s * cyl_static_tau[idx] * tau_jit)
            tau_neg_i = tau_i * cfg.rarefaction_tau_mult
            delay_r_i = tau_i * cfg.rarefaction_delay_mult

            if cyl.bank == 0:
                _scatter_blowdown_pulse(
                    bank0_raw,
                    turb0,
                    event_t * SAMPLE_RATE,
                    amp,
                    tau_i,
                    cfg.blowdown_exp,
                    cfg.shock_mix,
                    cfg.rarefaction_depth,
                    tau_neg_i,
                    delay_r_i,
                )
            else:
                _scatter_blowdown_pulse(
                    bank1_raw,
                    turb1,
                    event_t * SAMPLE_RATE,
                    amp,
                    tau_i,
                    cfg.blowdown_exp,
                    cfg.shock_mix,
                    cfg.rarefaction_depth,
                    tau_neg_i,
                    delay_r_i,
                )

            # Corresponding intake valve induction suction pulse
            if cfg.intake_gain > 0.0:
                in_offset_s = (cfg.intake_angle_offset_deg / cfg.cycle_deg) * (
                    group_dur_s * (cfg.cycle_deg / group_deg)
                )
                in_t = (event_t + in_offset_s - (cyl.runner_delay_ms + 0.5 * t_jit_ms) * 1e-3) % duration_s
                _scatter_blowdown_pulse(
                    intake_raw,
                    intake_env,
                    in_t * SAMPLE_RATE,
                    amp * 0.85,
                    intake_tau_s * tau_jit,
                    1.42,
                    0.22,
                    0.22,
                    intake_tau_s * 2.15,
                    intake_tau_s * 1.18,
                )

    # Dual-bank exhaust header waveguide delays + collector comb interference
    b0_pipe = _circular_fft_shape(
        bank0_raw,
        lambda f: _waveguide_pipe_tf(
            f,
            cfg.bank0_delay_ms,
            cfg.pipe0_tau_ms,
            cfg.pipe_fwd_gain,
            cfg.pipe_fb_gain,
            cfg.pipe_damp_hz,
        ),
    )
    b1_pipe = _circular_fft_shape(
        bank1_raw,
        lambda f: _waveguide_pipe_tf(
            f,
            cfg.bank1_delay_ms,
            cfg.pipe1_tau_ms,
            cfg.pipe_fwd_gain,
            cfg.pipe_fb_gain,
            cfg.pipe_damp_hz,
        ),
    )

    # Collector / X-pipe / H-pipe cross-scavenging merge
    merged = b0_pipe + b1_pipe
    if cfg.xpipe_mix > 0.0:
        x_scav = _circular_fft_shape(
            b0_pipe - b1_pipe,
            lambda f: np.exp(-1j * 2.0 * math.pi * f * (cfg.xpipe_delay_ms * 1e-3))
            * _bandpass_curve(f, 80.0, 5200.0, order=2.0),
        )
        merged = merged + cfg.xpipe_mix * x_scav

    # Physical open-tailpipe acoustic radiation impedance
    merged = _circular_fft_shape(
        merged,
        lambda f: _tailpipe_radiation_curve(f, cfg.rad_corner_hz, cfg.rad_tilt_exp)
        * _bandpass_curve(f, cfg.band_lo_hz, cfg.band_hi_hz, order=1.8),
    )

    # Pulse-locked exhaust gas-velocity envelope
    turb_all = turb0 + turb1
    turb_peak = float(np.percentile(turb_all, 98)) + 1e-9
    turb_norm = np.clip(turb_all / turb_peak, 0.0, 2.0)

    # Wideband choked-flow exhaust turbulence roar locked to cylinder blowdowns
    exhaust_rms = float(np.sqrt(np.mean(merged * merged))) + 1e-9
    if cfg.rasp_gain > 0.0:
        rasp_noise = _circular_fft_shape(
            rng.standard_normal(n),
            lambda f: _bandpass_curve(f, cfg.rasp_lo_hz, cfg.rasp_hi_hz, order=2.0)
            * _waveguide_pipe_tf(
                f,
                0.5 * (cfg.bank0_delay_ms + cfg.bank1_delay_ms),
                0.5 * (cfg.pipe0_tau_ms + cfg.pipe1_tau_ms),
                cfg.pipe_fwd_gain * 0.65,
                cfg.pipe_fb_gain * 0.55,
                cfg.pipe_damp_hz,
            ),
        )
        rasp_noise /= float(np.sqrt(np.mean(rasp_noise * rasp_noise))) + 1e-9
        rasp = rasp_noise * (0.24 + 0.76 * turb_norm) * (exhaust_rms * cfg.rasp_gain)
    else:
        rasp = np.zeros(n, dtype=np.float64)

    # High-velocity choked-flow blowdown tearing-air texture
    if cfg.crackle_gain > 0.0:
        crackle_noise = _circular_fft_shape(
            rng.standard_normal(n),
            lambda f: _bandpass_curve(f, cfg.crackle_lo_hz, cfg.crackle_hi_hz, order=2.0),
        )
        crackle_noise /= float(np.sqrt(np.mean(crackle_noise * crackle_noise))) + 1e-9
        crackle = crackle_noise * (0.12 + 0.88 * (turb_norm ** 1.45)) * (exhaust_rms * cfg.crackle_gain)
    else:
        crackle = np.zeros(n, dtype=np.float64)

    exhaust_pre = merged + rasp + crackle

    # Broad, dry-ish muffler/header spectral contour (Q ~ 1.0-1.8)
    exhaust_body = _circular_fft_shape(
        exhaust_pre,
        lambda f: _bandpass_curve(f, cfg.band_lo_hz, cfg.band_hi_hz, order=2.0)
        * _resonator_bank(f, cfg.exhaust_formants),
    )

    # Asymmetric warm tube / titanium exhaust-shock saturation
    exhaust_sat = _asymmetric_saturate(exhaust_body, drive=cfg.sat_drive, asym=cfg.sat_asym)

    # Post-saturation broad polish & chest-weight shelf
    def _post_resp(f: np.ndarray) -> np.ndarray:
        h = _bandpass_curve(f, max(28.0, cfg.band_lo_hz * 0.8), min(15500.0, cfg.band_hi_hz * 1.25), order=2.0)
        if cfg.post_formants:
            h = h * _resonator_bank(f, cfg.post_formants)
        if cfg.sub_bass_boost_hz > 0.0 and cfg.sub_bass_gain > 0.0:
            bw_sub = cfg.sub_bass_boost_hz / 2.2  # broad Q ~ 1.1
            h = h * (1.0 + cfg.sub_bass_gain / (1.0 + ((f - cfg.sub_bass_boost_hz) / bw_sub) ** 2))
        return h

    exhaust_final = _circular_fft_shape(exhaust_sat, _post_resp)
    ex_rms = float(np.sqrt(np.mean(exhaust_final * exhaust_final))) + 1e-9

    # Sub-bass chest punch (fundamental + half-order crank throb at 45-110 Hz)
    if cfg.sub_punch_gain > 0.0:
        sub_candidates = [
            (f_fire, 1.00),
            (0.5 * f_fire, 0.78),
            (f_crank, 0.82),
            (0.5 * f_crank, 0.70),
            (1.5 * f_crank, 0.62),
            (2.0 * f_crank, 0.55),
            (2.0 * f_fire, 0.45),
        ]
        sub_partials: list[tuple[float, float, float]] = []
        used_bins: set[int] = set()
        for fc_cand, wt in sub_candidates:
            if 44.0 <= fc_cand <= 112.0:
                f_ex = _exact_cycle_freq(fc_cand, duration_s)
                key = int(round(f_ex / 4.0))
                if key not in used_bins:
                    used_bins.add(key)
                    sub_partials.append((f_ex, wt, float(rng.uniform(0.0, 0.8))))
            if len(sub_partials) >= 3:
                break
        if not sub_partials:
            f_fb = _exact_cycle_freq(min(105.0, max(48.0, f_crank)), duration_s)
            sub_partials.append((f_fb, 1.0, 0.2))
        sub_raw = _harmonic_sum(t, duration_s, sub_partials)
        sub_raw = np.tanh(1.25 * sub_raw)
        sub_raw = _circular_fft_shape(sub_raw, lambda f: _bandpass_curve(f, 34.0, 145.0, order=2.0))
        sub_raw /= float(np.sqrt(np.mean(sub_raw * sub_raw))) + 1e-9
        sub_part = sub_raw * (0.58 + 0.42 * turb_norm) * (ex_rms * cfg.sub_punch_gain)
    else:
        sub_part = np.zeros(n, dtype=np.float64)

    # Intake plenum / ITB roar + pressurized induction rush
    if cfg.intake_gain > 0.0:
        intake_shaped = _circular_fft_shape(
            intake_raw,
            lambda f: _tailpipe_radiation_curve(f, 1300.0, 0.85)
            * _bandpass_curve(f, 80.0, 7200.0, order=2.0)
            * _resonator_bank(f, cfg.intake_formants),
        )
        intake_shaped = _asymmetric_saturate(intake_shaped, drive=1.30, asym=0.06)
        intake_shaped /= float(np.sqrt(np.mean(intake_shaped * intake_shaped))) + 1e-9
        intake_part = intake_shaped * (ex_rms * cfg.intake_gain)

        in_env_norm = np.clip(intake_env / (float(np.percentile(intake_env, 98)) + 1e-9), 0.0, 2.0)
        rush = _circular_fft_shape(
            rng.standard_normal(n),
            lambda f: _bandpass_curve(f, cfg.intake_rush_band[0], cfg.intake_rush_band[1], order=2.0),
        )
        rush /= float(np.sqrt(np.mean(rush * rush))) + 1e-9
        intake_part = intake_part + rush * (0.38 + 0.62 * in_env_norm) * (ex_rms * cfg.intake_rush_gain)
    else:
        intake_part = np.zeros(n, dtype=np.float64)

    # Mechanical valvetrain / crankcase metallic sheen (2.5-6.5 kHz harmonics + friction)
    if cfg.mech_gain > 0.0:
        step_hz = max(f_crank, 28.0)
        k_lo = max(1, int(math.ceil(2500.0 / step_hz)))
        k_hi = max(k_lo, int(math.floor(6500.0 / step_hz)))
        n_orders = min(18, k_hi - k_lo + 1)
        order_grid = sorted({int(round(v)) for v in np.linspace(k_lo, k_hi, n_orders)})
        sheen_partials: list[tuple[float, float, float]] = []
        for k_ord in order_grid:
            fh = k_ord * step_hz
            if 2480.0 <= fh <= 6550.0:
                weight = 1.0 / (1.0 + ((fh - 4150.0) / 1650.0) ** 2)
                sheen_partials.append((fh, float(weight * rng.uniform(0.72, 1.28)), float(rng.uniform(0.0, 2.0 * math.pi))))
        sheen_tones = _harmonic_sum(t, duration_s, sheen_partials)
        sheen_rms = float(np.sqrt(np.mean(sheen_tones * sheen_tones))) + 1e-9
        sheen_tones = sheen_tones / sheen_rms

        mech_noise = _circular_fft_shape(
            rng.standard_normal(n),
            lambda f: _bandpass_curve(f, cfg.mech_band[0], cfg.mech_band[1], order=2.0),
        )
        mech_noise /= float(np.sqrt(np.mean(mech_noise * mech_noise))) + 1e-9
        mech_env = 0.45 + 0.55 * turb_norm
        mech_part = (0.48 * sheen_tones + 0.52 * mech_noise) * mech_env * (ex_rms * cfg.mech_gain)
    else:
        mech_part = np.zeros(n, dtype=np.float64)

    total = exhaust_final + sub_part + intake_part + mech_part

    # Optional crank-coupled forced-induction layer (Roots / twin-screw supercharger whine)
    if extra_layer_fn is not None:
        extra = extra_layer_fn(t, duration_s, f_crank, rng)
        total = total + extra * ex_rms

    # Subtle exact-integer-cycle dyno-load micro-breathing (100% periodic on duration_s)
    f_b1 = 1.0 / duration_s
    f_b2 = 2.0 / duration_s
    breath = (
        1.0
        + 0.012 * np.sin(2.0 * math.pi * f_b1 * t + 0.3)
        + 0.007 * np.sin(2.0 * math.pi * f_b2 * t + 1.9)
    )
    return _finalize_loop(total * breath, target_rms_dbfs=cfg.target_rms_dbfs)


# ---- Canonical Real-World Cylinder Layouts -------------------------------------------------------

# Porsche 992 GT3 RS Flat-6 (firing order 1-6-2-4-3-5, alternating L/R every 120°)
_CYL_FLAT6: tuple[CylinderEvent, ...] = (
    CylinderEvent(0.0, 0, 0.00, 1.01),
    CylinderEvent(120.0, 1, 0.14, 0.99),
    CylinderEvent(240.0, 0, 0.20, 1.00),
    CylinderEvent(360.0, 1, 0.08, 1.01),
    CylinderEvent(480.0, 0, 0.16, 0.99),
    CylinderEvent(600.0, 1, 0.24, 1.00),
)

# Ferrari Daytona SP3 65° V12 (1-12-5-8-3-10-6-7-2-11-4-9, alternating L/R every 60°)
_CYL_V12: tuple[CylinderEvent, ...] = tuple(
    CylinderEvent(
        angle_deg=i * 60.0,
        bank=i % 2,
        runner_delay_ms=0.05 * ((i * 5) % 4),
        amp_trim=0.985 + 0.03 * ((i % 3) / 2.0),
    )
    for i in range(12)
)

# Lamborghini Huracán / R8 90° Odd-Fire V10 (alternating 54° / 90° intervals!)
_CYL_V10_ODDFIRE: tuple[CylinderEvent, ...] = (
    CylinderEvent(0.0, 0, 0.00, 1.02),
    CylinderEvent(54.0, 1, 0.15, 0.99),
    CylinderEvent(144.0, 0, 0.10, 1.00),
    CylinderEvent(198.0, 1, 0.21, 1.01),
    CylinderEvent(288.0, 0, 0.07, 0.98),
    CylinderEvent(342.0, 1, 0.16, 1.01),
    CylinderEvent(432.0, 0, 0.19, 1.00),
    CylinderEvent(486.0, 1, 0.06, 0.99),
    CylinderEvent(576.0, 0, 0.12, 1.01),
    CylinderEvent(630.0, 1, 0.18, 0.99),
)

# Mazda 4-Rotor Wankel (0°, 90°, 180°, 270° eccentric shaft firing over 360°)
_CYL_ROTARY4: tuple[CylinderEvent, ...] = (
    CylinderEvent(0.0, 0, 0.00, 1.01),
    CylinderEvent(90.0, 1, 0.13, 0.99),
    CylinderEvent(180.0, 0, 0.09, 1.00),
    CylinderEvent(270.0, 1, 0.18, 1.00),
)

# RB26 / 2JZ Forged Inline-6 (1-5-3-6-2-4, 3+3 twin-scroll banks, even 120° firing)
_CYL_I6_TT: tuple[CylinderEvent, ...] = (
    CylinderEvent(0.0, 0, 0.00, 1.01),
    CylinderEvent(120.0, 1, 0.16, 1.00),
    CylinderEvent(240.0, 0, 0.10, 0.99),
    CylinderEvent(360.0, 1, 0.21, 1.01),
    CylinderEvent(480.0, 0, 0.07, 1.00),
    CylinderEvent(600.0, 1, 0.13, 0.99),
)

# American Cross-Plane V8 (1-8-4-3-6-5-7-2 -> uneven 90°/180°/270°/180° per-bank firing!)
_CYL_V8_CROSS: tuple[CylinderEvent, ...] = (
    CylinderEvent(0.0, 0, 0.00, 1.03),    # Cyl 1 (L)
    CylinderEvent(90.0, 1, 0.22, 0.98),   # Cyl 8 (R)
    CylinderEvent(180.0, 1, 0.11, 1.04),  # Cyl 4 (R) - consecutive R bank!
    CylinderEvent(270.0, 0, 0.26, 0.98),  # Cyl 3 (L)
    CylinderEvent(360.0, 1, 0.08, 1.01),  # Cyl 6 (R)
    CylinderEvent(450.0, 0, 0.19, 1.01),  # Cyl 5 (L)
    CylinderEvent(540.0, 0, 0.14, 1.04),  # Cyl 7 (L) - consecutive L bank!
    CylinderEvent(630.0, 1, 0.24, 0.97),  # Cyl 2 (R)
)

# Italian Flat-Plane V8 (1-5-3-7-4-8-2-6, strictly alternating L/R every 90°)
_CYL_V8_FLAT: tuple[CylinderEvent, ...] = (
    CylinderEvent(0.0, 0, 0.00, 1.01),
    CylinderEvent(90.0, 1, 0.07, 1.00),
    CylinderEvent(180.0, 0, 0.11, 0.99),
    CylinderEvent(270.0, 1, 0.05, 1.01),
    CylinderEvent(360.0, 0, 0.13, 1.00),
    CylinderEvent(450.0, 1, 0.09, 0.99),
    CylinderEvent(540.0, 0, 0.04, 1.01),
    CylinderEvent(630.0, 1, 0.10, 0.99),
)


# ---- 4-Zone Engine Synthesizers (30 Stems, 1.5 s Seamless Loops) ---------------------------------


# 1) Flat-6 NA (Porsche 992 GT3 RS) ---------------------------------------------------------------


def synth_eng_flat6_1000(rng: np.random.Generator) -> np.ndarray:
    """1000 RPM Flat-6 NA (GT3 RS) boxer idle with solid-lifter valvetrain sheen."""
    cfg = EnginePhysConfig(
        rpm=1000.0,
        cycle_deg=720.0,
        cylinders=_CYL_FLAT6,
        blowdown_tau_ms=2.30,
        blowdown_exp=1.28,
        shock_mix=0.66,
        rarefaction_depth=0.40,
        rarefaction_tau_mult=2.55,
        rad_corner_hz=1350.0,
        rad_tilt_exp=1.08,
        energy_jitter_frac=0.042,
        time_jitter_ms=0.16,
        tau_jitter_frac=0.036,
        bank0_delay_ms=1.85,
        bank1_delay_ms=3.10,
        pipe0_tau_ms=6.40,
        pipe1_tau_ms=7.15,
        pipe_fwd_gain=0.32,
        pipe_fb_gain=0.28,
        pipe_damp_hz=4000.0,
        xpipe_mix=0.24,
        xpipe_delay_ms=1.25,
        rasp_gain=0.30,
        rasp_lo_hz=220.0,
        rasp_hi_hz=3600.0,
        crackle_gain=0.14,
        crackle_lo_hz=1800.0,
        crackle_hi_hz=7800.0,
        band_lo_hz=34.0,
        band_hi_hz=8600.0,
        exhaust_formants=(
            _formant_q(82.0, 1.2, 0.95),
            _formant_q(210.0, 1.3, 0.90),
            _formant_q(540.0, 1.4, 0.85),
            _formant_q(1380.0, 1.5, 0.90),
        ),
        intake_gain=0.24,
        intake_formants=(_formant_q(170.0, 1.3, 0.85), _formant_q(620.0, 1.4, 0.85)),
        intake_rush_gain=0.07,
        mech_gain=0.075,
        sub_punch_gain=0.32,
        sub_bass_boost_hz=56.0,
        sub_bass_gain=0.42,
        sat_drive=1.70,
        sat_asym=0.13,
        post_formants=(_formant_q(1450.0, 1.2, 0.45),),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_flat6_low(rng: np.random.Generator) -> np.ndarray:
    """2400 RPM Flat-6 NA (GT3 RS) punchy mid-low boxer growl."""
    cfg = EnginePhysConfig(
        rpm=2400.0,
        cycle_deg=720.0,
        cylinders=_CYL_FLAT6,
        blowdown_tau_ms=1.08,
        blowdown_exp=1.26,
        shock_mix=0.74,
        rarefaction_depth=0.36,
        rarefaction_tau_mult=2.45,
        rad_corner_hz=1750.0,
        rad_tilt_exp=1.14,
        energy_jitter_frac=0.036,
        time_jitter_ms=0.13,
        tau_jitter_frac=0.032,
        bank0_delay_ms=1.70,
        bank1_delay_ms=2.85,
        pipe0_tau_ms=4.60,
        pipe1_tau_ms=5.15,
        pipe_fwd_gain=0.33,
        pipe_fb_gain=0.30,
        pipe_damp_hz=4800.0,
        xpipe_mix=0.25,
        xpipe_delay_ms=1.05,
        rasp_gain=0.34,
        rasp_lo_hz=300.0,
        rasp_hi_hz=4600.0,
        crackle_gain=0.19,
        crackle_lo_hz=2000.0,
        crackle_hi_hz=9600.0,
        band_lo_hz=38.0,
        band_hi_hz=10400.0,
        exhaust_formants=(
            _formant_q(120.0, 1.2, 0.90),
            _formant_q(360.0, 1.4, 0.95),
            _formant_q(1180.0, 1.5, 1.05),
            _formant_q(2350.0, 1.6, 0.85),
        ),
        intake_gain=0.28,
        intake_formants=(_formant_q(240.0, 1.3, 0.90), _formant_q(820.0, 1.4, 0.95)),
        intake_rush_gain=0.09,
        mech_gain=0.075,
        sub_punch_gain=0.28,
        sub_bass_boost_hz=78.0,
        sub_bass_gain=0.36,
        sat_drive=1.82,
        sat_asym=0.13,
        post_formants=(_formant_q(1550.0, 1.3, 0.50),),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_flat6_4000(rng: np.random.Generator) -> np.ndarray:
    """4800 RPM Flat-6 NA (GT3 RS) metallic flat-6 howl & ITB roar."""
    cfg = EnginePhysConfig(
        rpm=4800.0,
        cycle_deg=720.0,
        cylinders=_CYL_FLAT6,
        blowdown_tau_ms=0.46,
        blowdown_exp=1.22,
        shock_mix=0.84,
        rarefaction_depth=0.32,
        rarefaction_tau_mult=2.25,
        rad_corner_hz=2550.0,
        rad_tilt_exp=1.22,
        energy_jitter_frac=0.032,
        time_jitter_ms=0.10,
        tau_jitter_frac=0.028,
        bank0_delay_ms=1.40,
        bank1_delay_ms=2.25,
        pipe0_tau_ms=2.55,
        pipe1_tau_ms=2.90,
        pipe_fwd_gain=0.34,
        pipe_fb_gain=0.32,
        pipe_damp_hz=6600.0,
        xpipe_mix=0.26,
        xpipe_delay_ms=0.80,
        rasp_gain=0.36,
        rasp_lo_hz=480.0,
        rasp_hi_hz=6800.0,
        crackle_gain=0.24,
        crackle_lo_hz=2600.0,
        crackle_hi_hz=12400.0,
        band_lo_hz=46.0,
        band_hi_hz=13200.0,
        exhaust_formants=(
            _formant_q(240.0, 1.2, 0.80),
            _formant_q(720.0, 1.4, 1.00),
            _formant_q(1680.0, 1.6, 1.20),
            _formant_q(3150.0, 1.6, 1.05),
        ),
        intake_gain=0.30,
        intake_formants=(_formant_q(460.0, 1.3, 0.90), _formant_q(1380.0, 1.5, 1.05)),
        intake_rush_gain=0.11,
        intake_rush_band=(1200.0, 8200.0),
        mech_gain=0.082,
        sub_punch_gain=0.22,
        sub_bass_boost_hz=80.0,
        sub_bass_gain=0.30,
        sat_drive=1.95,
        sat_asym=0.14,
        post_formants=(_formant_q(1850.0, 1.3, 0.55), _formant_q(3400.0, 1.4, 0.50)),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_flat6_7800(rng: np.random.Generator) -> np.ndarray:
    """7800 RPM Flat-6 NA (GT3 RS) feral 9000-RPM titanium motorsport shriek."""
    cfg = EnginePhysConfig(
        rpm=7800.0,
        cycle_deg=720.0,
        cylinders=_CYL_FLAT6,
        blowdown_tau_ms=0.26,
        blowdown_exp=1.18,
        shock_mix=0.92,
        rarefaction_depth=0.28,
        rarefaction_tau_mult=2.05,
        rad_corner_hz=3300.0,
        rad_tilt_exp=1.28,
        energy_jitter_frac=0.028,
        time_jitter_ms=0.08,
        tau_jitter_frac=0.025,
        bank0_delay_ms=1.20,
        bank1_delay_ms=1.88,
        pipe0_tau_ms=1.78,
        pipe1_tau_ms=2.02,
        pipe_fwd_gain=0.35,
        pipe_fb_gain=0.34,
        pipe_damp_hz=8400.0,
        xpipe_mix=0.28,
        xpipe_delay_ms=0.65,
        rasp_gain=0.36,
        rasp_lo_hz=700.0,
        rasp_hi_hz=8800.0,
        crackle_gain=0.28,
        crackle_lo_hz=3200.0,
        crackle_hi_hz=14800.0,
        band_lo_hz=52.0,
        band_hi_hz=15000.0,
        exhaust_formants=(
            _formant_q(390.0, 1.2, 0.75),
            _formant_q(1180.0, 1.5, 1.05),
            _formant_q(2450.0, 1.6, 1.25),
            _formant_q(4450.0, 1.6, 1.15),
        ),
        intake_gain=0.32,
        intake_formants=(_formant_q(760.0, 1.4, 0.90), _formant_q(2250.0, 1.5, 1.10)),
        intake_rush_gain=0.12,
        intake_rush_band=(1600.0, 10200.0),
        mech_gain=0.092,
        sub_punch_gain=0.18,
        sub_bass_boost_hz=66.0,
        sub_bass_gain=0.25,
        sat_drive=2.08,
        sat_asym=0.15,
        post_formants=(_formant_q(2600.0, 1.3, 0.55), _formant_q(4800.0, 1.4, 0.55)),
    )
    return _synth_physical_engine(cfg, rng)


# 2) V12 NA (Ferrari Daytona SP3 / Corsa) ----------------------------------------------------------


def synth_eng_v12_1000(rng: np.random.Generator) -> np.ndarray:
    """1000 RPM V12 NA (Daytona SP3 / Corsa) silky exotic idle with 6-per-bank undertone."""
    cfg = EnginePhysConfig(
        rpm=1000.0,
        cycle_deg=720.0,
        cylinders=_CYL_V12,
        blowdown_tau_ms=2.00,
        blowdown_exp=1.28,
        shock_mix=0.60,
        rarefaction_depth=0.36,
        rarefaction_tau_mult=2.50,
        rad_corner_hz=1600.0,
        rad_tilt_exp=1.10,
        energy_jitter_frac=0.036,
        time_jitter_ms=0.14,
        tau_jitter_frac=0.032,
        bank0_delay_ms=1.95,
        bank1_delay_ms=2.32,
        pipe0_tau_ms=5.40,
        pipe1_tau_ms=5.70,
        pipe_fwd_gain=0.28,
        pipe_fb_gain=0.28,
        pipe_damp_hz=4800.0,
        xpipe_mix=0.28,
        xpipe_delay_ms=0.65,
        rasp_gain=0.22,
        rasp_lo_hz=260.0,
        rasp_hi_hz=4200.0,
        crackle_gain=0.12,
        crackle_lo_hz=2000.0,
        crackle_hi_hz=8800.0,
        band_lo_hz=36.0,
        band_hi_hz=9600.0,
        exhaust_formants=(
            _formant_q(100.0, 1.2, 0.90),
            _formant_q(310.0, 1.3, 0.90),
            _formant_q(980.0, 1.5, 0.95),
            _formant_q(2100.0, 1.5, 0.80),
        ),
        intake_gain=0.24,
        intake_formants=(_formant_q(220.0, 1.3, 0.85), _formant_q(740.0, 1.4, 0.85)),
        intake_rush_gain=0.07,
        mech_gain=0.070,
        sub_punch_gain=0.28,
        sub_bass_boost_hz=54.0,
        sub_bass_gain=0.35,
        sat_drive=1.52,
        sat_asym=0.10,
        post_formants=(_formant_q(1200.0, 1.2, 0.45),),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v12_low(rng: np.random.Generator) -> np.ndarray:
    """2500 RPM V12 NA (Daytona SP3 / Corsa) deep exotic V12 pull."""
    cfg = EnginePhysConfig(
        rpm=2500.0,
        cycle_deg=720.0,
        cylinders=_CYL_V12,
        blowdown_tau_ms=0.82,
        blowdown_exp=1.26,
        shock_mix=0.72,
        rarefaction_depth=0.33,
        rarefaction_tau_mult=2.38,
        rad_corner_hz=2100.0,
        rad_tilt_exp=1.18,
        energy_jitter_frac=0.032,
        time_jitter_ms=0.11,
        tau_jitter_frac=0.028,
        bank0_delay_ms=1.75,
        bank1_delay_ms=2.08,
        pipe0_tau_ms=3.55,
        pipe1_tau_ms=3.78,
        pipe_fwd_gain=0.30,
        pipe_fb_gain=0.30,
        pipe_damp_hz=5800.0,
        xpipe_mix=0.30,
        xpipe_delay_ms=0.58,
        rasp_gain=0.26,
        rasp_lo_hz=380.0,
        rasp_hi_hz=5400.0,
        crackle_gain=0.16,
        crackle_lo_hz=2400.0,
        crackle_hi_hz=10800.0,
        band_lo_hz=42.0,
        band_hi_hz=11600.0,
        exhaust_formants=(
            _formant_q(125.0, 1.2, 0.85),
            _formant_q(460.0, 1.4, 0.95),
            _formant_q(1380.0, 1.5, 1.10),
            _formant_q(2650.0, 1.6, 0.95),
        ),
        intake_gain=0.26,
        intake_formants=(_formant_q(340.0, 1.3, 0.85), _formant_q(1100.0, 1.5, 0.95)),
        intake_rush_gain=0.09,
        mech_gain=0.074,
        sub_punch_gain=0.25,
        sub_bass_boost_hz=84.0,
        sub_bass_gain=0.32,
        sat_drive=1.65,
        sat_asym=0.11,
        post_formants=(_formant_q(1520.0, 1.3, 0.50),),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v12_5000(rng: np.random.Generator) -> np.ndarray:
    """5000 RPM V12 NA (Daytona SP3 / Corsa) howling exotic V12 mid-high."""
    cfg = EnginePhysConfig(
        rpm=5000.0,
        cycle_deg=720.0,
        cylinders=_CYL_V12,
        blowdown_tau_ms=0.34,
        blowdown_exp=1.22,
        shock_mix=0.86,
        rarefaction_depth=0.28,
        rarefaction_tau_mult=2.15,
        rad_corner_hz=2950.0,
        rad_tilt_exp=1.25,
        energy_jitter_frac=0.028,
        time_jitter_ms=0.09,
        tau_jitter_frac=0.026,
        bank0_delay_ms=1.50,
        bank1_delay_ms=1.76,
        pipe0_tau_ms=1.95,
        pipe1_tau_ms=2.08,
        pipe_fwd_gain=0.33,
        pipe_fb_gain=0.33,
        pipe_damp_hz=7600.0,
        xpipe_mix=0.32,
        xpipe_delay_ms=0.50,
        rasp_gain=0.28,
        rasp_lo_hz=640.0,
        rasp_hi_hz=7600.0,
        crackle_gain=0.22,
        crackle_lo_hz=3000.0,
        crackle_hi_hz=13800.0,
        band_lo_hz=48.0,
        band_hi_hz=14200.0,
        exhaust_formants=(
            _formant_q(250.0, 1.2, 0.75),
            _formant_q(980.0, 1.5, 1.05),
            _formant_q(2100.0, 1.6, 1.25),
            _formant_q(3900.0, 1.6, 1.10),
        ),
        intake_gain=0.28,
        intake_formants=(_formant_q(580.0, 1.3, 0.85), _formant_q(1750.0, 1.5, 1.05)),
        intake_rush_gain=0.10,
        intake_rush_band=(1500.0, 9600.0),
        mech_gain=0.080,
        sub_punch_gain=0.20,
        sub_bass_boost_hz=84.0,
        sub_bass_gain=0.26,
        sat_drive=1.82,
        sat_asym=0.12,
        post_formants=(_formant_q(2100.0, 1.3, 0.55), _formant_q(3800.0, 1.4, 0.50)),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v12_8000(rng: np.random.Generator) -> np.ndarray:
    """8000 RPM V12 NA (Daytona SP3 / Corsa) F1-grade V12 soprano scream."""
    cfg = EnginePhysConfig(
        rpm=8000.0,
        cycle_deg=720.0,
        cylinders=_CYL_V12,
        blowdown_tau_ms=0.22,
        blowdown_exp=1.18,
        shock_mix=0.94,
        rarefaction_depth=0.25,
        rarefaction_tau_mult=2.00,
        rad_corner_hz=3600.0,
        rad_tilt_exp=1.30,
        energy_jitter_frac=0.025,
        time_jitter_ms=0.08,
        tau_jitter_frac=0.024,
        bank0_delay_ms=1.30,
        bank1_delay_ms=1.52,
        pipe0_tau_ms=1.42,
        pipe1_tau_ms=1.52,
        pipe_fwd_gain=0.34,
        pipe_fb_gain=0.35,
        pipe_damp_hz=9200.0,
        xpipe_mix=0.34,
        xpipe_delay_ms=0.42,
        rasp_gain=0.30,
        rasp_lo_hz=850.0,
        rasp_hi_hz=9600.0,
        crackle_gain=0.26,
        crackle_lo_hz=3600.0,
        crackle_hi_hz=15500.0,
        band_lo_hz=52.0,
        band_hi_hz=15600.0,
        exhaust_formants=(
            _formant_q(400.0, 1.2, 0.70),
            _formant_q(1600.0, 1.5, 1.15),
            _formant_q(3200.0, 1.6, 1.30),
            _formant_q(5200.0, 1.6, 1.15),
        ),
        intake_gain=0.30,
        intake_formants=(_formant_q(920.0, 1.4, 0.90), _formant_q(2800.0, 1.5, 1.10)),
        intake_rush_gain=0.11,
        intake_rush_band=(2000.0, 11200.0),
        mech_gain=0.088,
        sub_punch_gain=0.16,
        sub_bass_boost_hz=68.0,
        sub_bass_gain=0.24,
        sat_drive=1.94,
        sat_asym=0.13,
        post_formants=(_formant_q(3200.0, 1.3, 0.55), _formant_q(5400.0, 1.4, 0.55)),
    )
    return _synth_physical_engine(cfg, rng)


# 3) V10 Screamer (Huracán / Fulmine) --------------------------------------------------------------


def synth_eng_v10_1000(rng: np.random.Generator) -> np.ndarray:
    """1000 RPM V10 Screamer (Huracán / Fulmine) odd-fire 54°/90° idle."""
    cfg = EnginePhysConfig(
        rpm=1000.0,
        cycle_deg=720.0,
        cylinders=_CYL_V10_ODDFIRE,
        blowdown_tau_ms=2.05,
        blowdown_exp=1.26,
        shock_mix=0.68,
        rarefaction_depth=0.38,
        rarefaction_tau_mult=2.50,
        rad_corner_hz=1550.0,
        rad_tilt_exp=1.10,
        energy_jitter_frac=0.042,
        time_jitter_ms=0.16,
        tau_jitter_frac=0.036,
        bank0_delay_ms=1.75,
        bank1_delay_ms=2.60,
        pipe0_tau_ms=5.55,
        pipe1_tau_ms=6.15,
        pipe_fwd_gain=0.32,
        pipe_fb_gain=0.30,
        pipe_damp_hz=4500.0,
        xpipe_mix=0.25,
        xpipe_delay_ms=1.00,
        rasp_gain=0.32,
        rasp_lo_hz=240.0,
        rasp_hi_hz=4000.0,
        crackle_gain=0.16,
        crackle_lo_hz=1900.0,
        crackle_hi_hz=8600.0,
        band_lo_hz=34.0,
        band_hi_hz=9200.0,
        exhaust_formants=(
            _formant_q(84.0, 1.2, 0.95),
            _formant_q(260.0, 1.3, 0.95),
            _formant_q(880.0, 1.5, 1.00),
            _formant_q(1850.0, 1.5, 0.85),
        ),
        intake_gain=0.25,
        intake_formants=(_formant_q(210.0, 1.3, 0.85), _formant_q(680.0, 1.4, 0.85)),
        intake_rush_gain=0.08,
        mech_gain=0.072,
        sub_punch_gain=0.30,
        sub_bass_boost_hz=64.0,
        sub_bass_gain=0.38,
        sat_drive=1.74,
        sat_asym=0.14,
        post_formants=(_formant_q(1080.0, 1.2, 0.45),),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v10_low(rng: np.random.Generator) -> np.ndarray:
    """2400 RPM V10 Screamer (Huracán / Fulmine) throaty odd-fire V10 rasp."""
    cfg = EnginePhysConfig(
        rpm=2400.0,
        cycle_deg=720.0,
        cylinders=_CYL_V10_ODDFIRE,
        blowdown_tau_ms=0.92,
        blowdown_exp=1.25,
        shock_mix=0.76,
        rarefaction_depth=0.35,
        rarefaction_tau_mult=2.40,
        rad_corner_hz=2050.0,
        rad_tilt_exp=1.18,
        energy_jitter_frac=0.036,
        time_jitter_ms=0.13,
        tau_jitter_frac=0.032,
        bank0_delay_ms=1.60,
        bank1_delay_ms=2.35,
        pipe0_tau_ms=3.95,
        pipe1_tau_ms=4.40,
        pipe_fwd_gain=0.33,
        pipe_fb_gain=0.31,
        pipe_damp_hz=5400.0,
        xpipe_mix=0.26,
        xpipe_delay_ms=0.90,
        rasp_gain=0.34,
        rasp_lo_hz=330.0,
        rasp_hi_hz=5200.0,
        crackle_gain=0.20,
        crackle_lo_hz=2200.0,
        crackle_hi_hz=10400.0,
        band_lo_hz=40.0,
        band_hi_hz=11000.0,
        exhaust_formants=(
            _formant_q(100.0, 1.2, 0.85),
            _formant_q(400.0, 1.4, 1.00),
            _formant_q(1160.0, 1.5, 1.10),
            _formant_q(2320.0, 1.6, 0.95),
        ),
        intake_gain=0.27,
        intake_formants=(_formant_q(300.0, 1.3, 0.85), _formant_q(960.0, 1.5, 0.95)),
        intake_rush_gain=0.09,
        mech_gain=0.076,
        sub_punch_gain=0.26,
        sub_bass_boost_hz=80.0,
        sub_bass_gain=0.34,
        sat_drive=1.86,
        sat_asym=0.14,
        post_formants=(_formant_q(1240.0, 1.3, 0.50),),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v10_5500(rng: np.random.Generator) -> np.ndarray:
    """5200 RPM V10 Screamer (Huracán / Fulmine) screaming odd-fire V10 wail."""
    cfg = EnginePhysConfig(
        rpm=5200.0,
        cycle_deg=720.0,
        cylinders=_CYL_V10_ODDFIRE,
        blowdown_tau_ms=0.36,
        blowdown_exp=1.22,
        shock_mix=0.88,
        rarefaction_depth=0.30,
        rarefaction_tau_mult=2.18,
        rad_corner_hz=2850.0,
        rad_tilt_exp=1.25,
        energy_jitter_frac=0.030,
        time_jitter_ms=0.09,
        tau_jitter_frac=0.026,
        bank0_delay_ms=1.35,
        bank1_delay_ms=1.95,
        pipe0_tau_ms=2.05,
        pipe1_tau_ms=2.30,
        pipe_fwd_gain=0.35,
        pipe_fb_gain=0.33,
        pipe_damp_hz=7400.0,
        xpipe_mix=0.28,
        xpipe_delay_ms=0.70,
        rasp_gain=0.36,
        rasp_lo_hz=560.0,
        rasp_hi_hz=7400.0,
        crackle_gain=0.25,
        crackle_lo_hz=2800.0,
        crackle_hi_hz=13800.0,
        band_lo_hz=46.0,
        band_hi_hz=14000.0,
        exhaust_formants=(
            _formant_q(218.0, 1.2, 0.75),
            _formant_q(870.0, 1.5, 1.05),
            _formant_q(2150.0, 1.6, 1.25),
            _formant_q(3800.0, 1.6, 1.10),
        ),
        intake_gain=0.29,
        intake_formants=(_formant_q(520.0, 1.3, 0.85), _formant_q(1580.0, 1.5, 1.05)),
        intake_rush_gain=0.11,
        intake_rush_band=(1400.0, 9400.0),
        mech_gain=0.084,
        sub_punch_gain=0.20,
        sub_bass_boost_hz=86.0,
        sub_bass_gain=0.28,
        sat_drive=2.00,
        sat_asym=0.15,
        post_formants=(_formant_q(2200.0, 1.3, 0.55), _formant_q(3850.0, 1.4, 0.50)),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v10_7800(rng: np.random.Generator) -> np.ndarray:
    """7800 RPM V10 Screamer (Huracán / Fulmine) redline V10 F1 shriek."""
    cfg = EnginePhysConfig(
        rpm=7800.0,
        cycle_deg=720.0,
        cylinders=_CYL_V10_ODDFIRE,
        blowdown_tau_ms=0.23,
        blowdown_exp=1.18,
        shock_mix=0.94,
        rarefaction_depth=0.26,
        rarefaction_tau_mult=2.02,
        rad_corner_hz=3500.0,
        rad_tilt_exp=1.30,
        energy_jitter_frac=0.026,
        time_jitter_ms=0.08,
        tau_jitter_frac=0.024,
        bank0_delay_ms=1.18,
        bank1_delay_ms=1.70,
        pipe0_tau_ms=1.50,
        pipe1_tau_ms=1.68,
        pipe_fwd_gain=0.36,
        pipe_fb_gain=0.35,
        pipe_damp_hz=9000.0,
        xpipe_mix=0.30,
        xpipe_delay_ms=0.55,
        rasp_gain=0.36,
        rasp_lo_hz=780.0,
        rasp_hi_hz=9400.0,
        crackle_gain=0.28,
        crackle_lo_hz=3400.0,
        crackle_hi_hz=15400.0,
        band_lo_hz=50.0,
        band_hi_hz=15500.0,
        exhaust_formants=(
            _formant_q(325.0, 1.2, 0.70),
            _formant_q(1300.0, 1.5, 1.10),
            _formant_q(2850.0, 1.6, 1.30),
            _formant_q(4900.0, 1.6, 1.15),
        ),
        intake_gain=0.31,
        intake_formants=(_formant_q(820.0, 1.4, 0.90), _formant_q(2500.0, 1.5, 1.10)),
        intake_rush_gain=0.12,
        intake_rush_band=(1800.0, 10800.0),
        mech_gain=0.092,
        sub_punch_gain=0.17,
        sub_bass_boost_hz=65.0,
        sub_bass_gain=0.24,
        sat_drive=2.12,
        sat_asym=0.15,
        post_formants=(_formant_q(2950.0, 1.3, 0.55), _formant_q(5100.0, 1.4, 0.55)),
    )
    return _synth_physical_engine(cfg, rng)


# 4) 4-Rotor Bridge-Port (RX-7 FD / 787B) ----------------------------------------------------------


def synth_eng_rotary4_1100(rng: np.random.Generator) -> np.ndarray:
    """
    1100 RPM 4-Rotor Bridge-Port (RX-7 FD) unmistakable ~9 Hz BRAP-BRAP-BRAP idle!
    28 eccentric shaft revs in 1.5 s (1120 RPM) = 14 exact 2-rev BRAP supercycles (9.33 Hz BRAP).
    """
    brap_pattern = (
        1.64, 1.34, 0.88, 0.34,  # explosive bridge-port BRAP!
        0.14, 0.20, 0.32, 0.78,  # overlap scavenging lull -> catch rising into next BRAP!
    )
    cfg = EnginePhysConfig(
        rpm=1120.0,  # 28 exact revs in 1.5 s = 14 exact 2-rev BRAP supercycles (9.33 Hz)
        cycle_deg=360.0,
        cylinders=_CYL_ROTARY4,
        bank_symmetric=False,
        blowdown_tau_ms=0.82,
        blowdown_exp=1.15,  # razor-fast sliding apex-seal exhaust port opening
        shock_mix=0.92,
        rarefaction_depth=0.40,
        rarefaction_tau_mult=2.25,
        rarefaction_delay_mult=1.05,
        rad_corner_hz=2050.0,
        rad_tilt_exp=1.18,
        energy_jitter_frac=0.045,  # intentional BRAP pattern drives pulse rhythm; CCV stays tight
        time_jitter_ms=0.16,
        tau_jitter_frac=0.040,
        supercycle_pattern=brap_pattern,
        bank0_delay_ms=1.55,
        bank1_delay_ms=2.30,
        pipe0_tau_ms=4.50,
        pipe1_tau_ms=4.95,
        pipe_fwd_gain=0.36,
        pipe_fb_gain=0.34,
        pipe_damp_hz=5600.0,
        xpipe_mix=0.22,
        xpipe_delay_ms=1.00,
        rasp_gain=0.38,
        rasp_lo_hz=260.0,
        rasp_hi_hz=5400.0,
        crackle_gain=0.24,
        crackle_lo_hz=2000.0,
        crackle_hi_hz=9800.0,
        band_lo_hz=38.0,
        band_hi_hz=10600.0,
        exhaust_formants=(
            _formant_q(75.0, 1.2, 0.90),
            _formant_q(320.0, 1.4, 1.05),
            _formant_q(820.0, 1.5, 1.15),
            _formant_q(1750.0, 1.6, 1.15),
        ),
        intake_gain=0.25,
        intake_tau_mult=1.40,
        intake_angle_offset_deg=-135.0,
        intake_formants=(_formant_q(220.0, 1.3, 0.90), _formant_q(720.0, 1.4, 0.95)),
        intake_rush_gain=0.10,
        mech_gain=0.075,
        sub_punch_gain=0.28,
        sub_bass_boost_hz=74.0,
        sub_bass_gain=0.36,
        sat_drive=2.08,
        sat_asym=0.17,
        post_formants=(_formant_q(850.0, 1.3, 0.50), _formant_q(1800.0, 1.3, 0.55)),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_rotary4_low(rng: np.random.Generator) -> np.ndarray:
    """2600 RPM 4-Rotor (RX-7 FD) snappy rotary pull once bridge-port overlap cleans up."""
    cfg = EnginePhysConfig(
        rpm=2600.0,
        cycle_deg=360.0,
        cylinders=_CYL_ROTARY4,
        blowdown_tau_ms=0.58,
        blowdown_exp=1.15,
        shock_mix=0.90,
        rarefaction_depth=0.34,
        rarefaction_tau_mult=2.15,
        rarefaction_delay_mult=1.05,
        rad_corner_hz=2350.0,
        rad_tilt_exp=1.22,
        energy_jitter_frac=0.036,
        time_jitter_ms=0.12,
        tau_jitter_frac=0.032,
        bank0_delay_ms=1.40,
        bank1_delay_ms=2.05,
        pipe0_tau_ms=3.35,
        pipe1_tau_ms=3.70,
        pipe_fwd_gain=0.36,
        pipe_fb_gain=0.34,
        pipe_damp_hz=6400.0,
        xpipe_mix=0.24,
        xpipe_delay_ms=0.85,
        rasp_gain=0.36,
        rasp_lo_hz=360.0,
        rasp_hi_hz=6200.0,
        crackle_gain=0.24,
        crackle_lo_hz=2300.0,
        crackle_hi_hz=11200.0,
        band_lo_hz=44.0,
        band_hi_hz=12000.0,
        exhaust_formants=(
            _formant_q(174.0, 1.2, 0.85),
            _formant_q(580.0, 1.5, 1.10),
            _formant_q(1480.0, 1.6, 1.20),
            _formant_q(2800.0, 1.6, 1.00),
        ),
        intake_gain=0.27,
        intake_tau_mult=1.35,
        intake_angle_offset_deg=-130.0,
        intake_formants=(_formant_q(320.0, 1.3, 0.90), _formant_q(1080.0, 1.5, 1.00)),
        intake_rush_gain=0.11,
        mech_gain=0.080,
        sub_punch_gain=0.24,
        sub_bass_boost_hz=86.0,
        sub_bass_gain=0.32,
        sat_drive=2.05,
        sat_asym=0.16,
        post_formants=(_formant_q(1520.0, 1.3, 0.50),),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_rotary4_6000(rng: np.random.Generator) -> np.ndarray:
    """5500 RPM 4-Rotor (787B) buzzing peripheral-port mid-high howl."""
    cfg = EnginePhysConfig(
        rpm=5500.0,
        cycle_deg=360.0,
        cylinders=_CYL_ROTARY4,
        blowdown_tau_ms=0.30,
        blowdown_exp=1.14,
        shock_mix=0.94,
        rarefaction_depth=0.29,
        rarefaction_tau_mult=2.05,
        rarefaction_delay_mult=1.04,
        rad_corner_hz=3200.0,
        rad_tilt_exp=1.28,
        energy_jitter_frac=0.030,
        time_jitter_ms=0.09,
        tau_jitter_frac=0.026,
        bank0_delay_ms=1.20,
        bank1_delay_ms=1.72,
        pipe0_tau_ms=2.10,
        pipe1_tau_ms=2.32,
        pipe_fwd_gain=0.37,
        pipe_fb_gain=0.35,
        pipe_damp_hz=8200.0,
        xpipe_mix=0.26,
        xpipe_delay_ms=0.60,
        rasp_gain=0.36,
        rasp_lo_hz=640.0,
        rasp_hi_hz=8400.0,
        crackle_gain=0.26,
        crackle_lo_hz=3000.0,
        crackle_hi_hz=14200.0,
        band_lo_hz=50.0,
        band_hi_hz=14500.0,
        exhaust_formants=(
            _formant_q(366.0, 1.3, 0.80),
            _formant_q(1180.0, 1.5, 1.15),
            _formant_q(2450.0, 1.6, 1.25),
            _formant_q(4200.0, 1.6, 1.15),
        ),
        intake_gain=0.28,
        intake_tau_mult=1.30,
        intake_angle_offset_deg=-128.0,
        intake_formants=(_formant_q(460.0, 1.3, 0.85), _formant_q(1680.0, 1.5, 1.05)),
        intake_rush_gain=0.12,
        intake_rush_band=(1700.0, 10500.0),
        mech_gain=0.088,
        sub_punch_gain=0.19,
        sub_bass_boost_hz=92.0,
        sub_bass_gain=0.26,
        sat_drive=2.16,
        sat_asym=0.16,
        post_formants=(_formant_q(2480.0, 1.3, 0.55), _formant_q(4350.0, 1.4, 0.50)),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_rotary4_8500(rng: np.random.Generator) -> np.ndarray:
    """8500 RPM 4-Rotor (787B) Le Mans chainsaw redline scream."""
    cfg = EnginePhysConfig(
        rpm=8500.0,
        cycle_deg=360.0,
        cylinders=_CYL_ROTARY4,
        blowdown_tau_ms=0.20,
        blowdown_exp=1.12,
        shock_mix=0.96,
        rarefaction_depth=0.25,
        rarefaction_tau_mult=1.95,
        rarefaction_delay_mult=1.02,
        rad_corner_hz=3850.0,
        rad_tilt_exp=1.32,
        energy_jitter_frac=0.025,
        time_jitter_ms=0.08,
        tau_jitter_frac=0.024,
        bank0_delay_ms=1.05,
        bank1_delay_ms=1.48,
        pipe0_tau_ms=1.45,
        pipe1_tau_ms=1.60,
        pipe_fwd_gain=0.38,
        pipe_fb_gain=0.36,
        pipe_damp_hz=9800.0,
        xpipe_mix=0.28,
        xpipe_delay_ms=0.48,
        rasp_gain=0.36,
        rasp_lo_hz=900.0,
        rasp_hi_hz=10400.0,
        crackle_gain=0.30,
        crackle_lo_hz=3600.0,
        crackle_hi_hz=15800.0,
        band_lo_hz=55.0,
        band_hi_hz=15800.0,
        exhaust_formants=(
            _formant_q(566.0, 1.3, 0.75),
            _formant_q(1700.0, 1.5, 1.15),
            _formant_q(3400.0, 1.6, 1.30),
            _formant_q(5600.0, 1.6, 1.20),
        ),
        intake_gain=0.30,
        intake_tau_mult=1.25,
        intake_angle_offset_deg=-125.0,
        intake_formants=(_formant_q(850.0, 1.4, 0.90), _formant_q(2800.0, 1.5, 1.10)),
        intake_rush_gain=0.13,
        intake_rush_band=(2200.0, 12000.0),
        mech_gain=0.095,
        sub_punch_gain=0.16,
        sub_bass_boost_hz=71.0,
        sub_bass_gain=0.22,
        sat_drive=2.24,
        sat_asym=0.17,
        post_formants=(_formant_q(3450.0, 1.3, 0.55), _formant_q(5700.0, 1.4, 0.55)),
    )
    return _synth_physical_engine(cfg, rng)


# 5) Forged TT Inline-6 / V6 (Skyline R34 / NSX / Integrale) ---------------------------------------


def synth_eng_tt_i6_1000(rng: np.random.Generator) -> np.ndarray:
    """1000 RPM Forged TT Inline-6 (RB26 / 2JZ) deep baritone straight-six idle."""
    cfg = EnginePhysConfig(
        rpm=1000.0,
        cycle_deg=720.0,
        cylinders=_CYL_I6_TT,
        blowdown_tau_ms=2.45,  # turbine housings smooth sharpest valve edges into deep baritone
        blowdown_exp=1.32,
        shock_mix=0.54,
        rarefaction_depth=0.40,
        rarefaction_tau_mult=2.60,
        rad_corner_hz=1250.0,
        rad_tilt_exp=1.02,
        energy_jitter_frac=0.038,
        time_jitter_ms=0.15,
        tau_jitter_frac=0.032,
        bank0_delay_ms=2.30,
        bank1_delay_ms=3.35,
        pipe0_tau_ms=6.60,
        pipe1_tau_ms=7.05,
        pipe_fwd_gain=0.27,
        pipe_fb_gain=0.25,
        pipe_damp_hz=3100.0,
        xpipe_mix=0.20,
        xpipe_delay_ms=1.10,
        rasp_gain=0.24,
        rasp_lo_hz=170.0,
        rasp_hi_hz=2800.0,
        crackle_gain=0.10,
        crackle_lo_hz=1500.0,
        crackle_hi_hz=6200.0,
        band_lo_hz=30.0,
        band_hi_hz=6600.0,
        exhaust_formants=(
            _formant_q(68.0, 1.1, 1.05),
            _formant_q(160.0, 1.3, 1.05),
            _formant_q(420.0, 1.4, 0.90),
            _formant_q(1050.0, 1.5, 0.75),
        ),
        intake_gain=0.22,
        intake_formants=(_formant_q(155.0, 1.3, 0.90), _formant_q(480.0, 1.4, 0.80)),
        intake_rush_gain=0.08,
        intake_rush_band=(900.0, 4800.0),
        mech_gain=0.052,
        sub_punch_gain=0.36,
        sub_bass_boost_hz=56.0,
        sub_bass_gain=0.50,
        sat_drive=1.58,
        sat_asym=0.10,
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_tt_i6_low(rng: np.random.Generator) -> np.ndarray:
    """2400 RPM Forged TT Inline-6 (RB26 / 2JZ) creamy baritone straight-six pull."""
    cfg = EnginePhysConfig(
        rpm=2400.0,
        cycle_deg=720.0,
        cylinders=_CYL_I6_TT,
        blowdown_tau_ms=1.18,
        blowdown_exp=1.30,
        shock_mix=0.62,
        rarefaction_depth=0.37,
        rarefaction_tau_mult=2.50,
        rad_corner_hz=1550.0,
        rad_tilt_exp=1.08,
        energy_jitter_frac=0.034,
        time_jitter_ms=0.12,
        tau_jitter_frac=0.030,
        bank0_delay_ms=1.95,
        bank1_delay_ms=2.85,
        pipe0_tau_ms=4.55,
        pipe1_tau_ms=4.95,
        pipe_fwd_gain=0.28,
        pipe_fb_gain=0.26,
        pipe_damp_hz=3900.0,
        xpipe_mix=0.22,
        xpipe_delay_ms=0.95,
        rasp_gain=0.28,
        rasp_lo_hz=240.0,
        rasp_hi_hz=4000.0,
        crackle_gain=0.14,
        crackle_lo_hz=1800.0,
        crackle_hi_hz=7800.0,
        band_lo_hz=36.0,
        band_hi_hz=8400.0,
        exhaust_formants=(
            _formant_q(120.0, 1.2, 1.00),
            _formant_q(280.0, 1.3, 1.05),
            _formant_q(740.0, 1.4, 0.95),
            _formant_q(1650.0, 1.5, 0.85),
        ),
        intake_gain=0.25,
        intake_formants=(_formant_q(240.0, 1.3, 0.90), _formant_q(760.0, 1.4, 0.85)),
        intake_rush_gain=0.10,
        intake_rush_band=(1100.0, 6200.0),
        mech_gain=0.056,
        sub_punch_gain=0.32,
        sub_bass_boost_hz=80.0,
        sub_bass_gain=0.44,
        sat_drive=1.68,
        sat_asym=0.11,
        post_formants=(_formant_q(680.0, 1.2, 0.45),),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_tt_i6_4000(rng: np.random.Generator) -> np.ndarray:
    """4500 RPM Forged TT Inline-6 (RB26 / 2JZ) full-boost baritone-to-sing roar."""
    cfg = EnginePhysConfig(
        rpm=4500.0,
        cycle_deg=720.0,
        cylinders=_CYL_I6_TT,
        blowdown_tau_ms=0.58,
        blowdown_exp=1.28,
        shock_mix=0.70,
        rarefaction_depth=0.34,
        rarefaction_tau_mult=2.35,
        rad_corner_hz=2050.0,
        rad_tilt_exp=1.15,
        energy_jitter_frac=0.030,
        time_jitter_ms=0.10,
        tau_jitter_frac=0.026,
        bank0_delay_ms=1.65,
        bank1_delay_ms=2.45,
        pipe0_tau_ms=3.00,
        pipe1_tau_ms=3.32,
        pipe_fwd_gain=0.30,
        pipe_fb_gain=0.28,
        pipe_damp_hz=5000.0,
        xpipe_mix=0.24,
        xpipe_delay_ms=0.85,
        rasp_gain=0.30,
        rasp_lo_hz=360.0,
        rasp_hi_hz=5400.0,
        crackle_gain=0.18,
        crackle_lo_hz=2200.0,
        crackle_hi_hz=9600.0,
        band_lo_hz=44.0,
        band_hi_hz=10400.0,
        exhaust_formants=(
            _formant_q(225.0, 1.2, 0.90),
            _formant_q(520.0, 1.4, 1.05),
            _formant_q(1260.0, 1.5, 1.05),
            _formant_q(2450.0, 1.5, 0.90),
        ),
        intake_gain=0.28,
        intake_formants=(_formant_q(420.0, 1.3, 0.90), _formant_q(1220.0, 1.4, 0.95)),
        intake_rush_gain=0.12,
        intake_rush_band=(1400.0, 7600.0),
        mech_gain=0.064,
        sub_punch_gain=0.25,
        sub_bass_boost_hz=76.0,
        sub_bass_gain=0.36,
        sat_drive=1.78,
        sat_asym=0.12,
        post_formants=(_formant_q(1280.0, 1.3, 0.50),),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_tt_i6_7000(rng: np.random.Generator) -> np.ndarray:
    """7000 RPM Forged TT Inline-6 (RB26 / 2JZ) singing straight-six redline wail."""
    cfg = EnginePhysConfig(
        rpm=7000.0,
        cycle_deg=720.0,
        cylinders=_CYL_I6_TT,
        blowdown_tau_ms=0.34,
        blowdown_exp=1.24,
        shock_mix=0.78,
        rarefaction_depth=0.30,
        rarefaction_tau_mult=2.20,
        rad_corner_hz=2650.0,
        rad_tilt_exp=1.22,
        energy_jitter_frac=0.026,
        time_jitter_ms=0.08,
        tau_jitter_frac=0.024,
        bank0_delay_ms=1.40,
        bank1_delay_ms=2.05,
        pipe0_tau_ms=2.10,
        pipe1_tau_ms=2.34,
        pipe_fwd_gain=0.32,
        pipe_fb_gain=0.30,
        pipe_damp_hz=6600.0,
        xpipe_mix=0.25,
        xpipe_delay_ms=0.70,
        rasp_gain=0.32,
        rasp_lo_hz=560.0,
        rasp_hi_hz=7400.0,
        crackle_gain=0.22,
        crackle_lo_hz=2800.0,
        crackle_hi_hz=12400.0,
        band_lo_hz=50.0,
        band_hi_hz=12800.0,
        exhaust_formants=(
            _formant_q(350.0, 1.2, 0.85),
            _formant_q(880.0, 1.4, 1.05),
            _formant_q(1960.0, 1.6, 1.15),
            _formant_q(3650.0, 1.6, 1.00),
        ),
        intake_gain=0.30,
        intake_formants=(_formant_q(660.0, 1.3, 0.90), _formant_q(1950.0, 1.5, 1.05)),
        intake_rush_gain=0.14,
        intake_rush_band=(1800.0, 9400.0),
        mech_gain=0.072,
        sub_punch_gain=0.20,
        sub_bass_boost_hz=60.0,
        sub_bass_gain=0.30,
        sat_drive=1.90,
        sat_asym=0.13,
        post_formants=(_formant_q(2050.0, 1.3, 0.50), _formant_q(3800.0, 1.4, 0.45)),
    )
    return _synth_physical_engine(cfg, rng)


# 6) Cross-Plane V8 (Vela GT / Muscle / Harrier) ---------------------------------------------------


def synth_eng_v8_cross_900(rng: np.random.Generator) -> np.ndarray:
    """900 RPM Cross-Plane V8 (Vela GT / Muscle) cammed unequal-bank burble — smooth, zero hiccups."""
    cfg = EnginePhysConfig(
        rpm=900.0,
        cycle_deg=720.0,
        cylinders=_CYL_V8_CROSS,
        bank_symmetric=False,
        blowdown_tau_ms=2.85,
        blowdown_exp=1.30,
        shock_mix=0.60,
        rarefaction_depth=0.44,
        rarefaction_tau_mult=2.65,
        rad_corner_hz=1100.0,
        rad_tilt_exp=0.98,
        energy_jitter_frac=0.044,  # genuine cross-plane bank firing creates burble, NOT random dips
        time_jitter_ms=0.18,
        tau_jitter_frac=0.038,
        bank0_delay_ms=2.10,
        bank1_delay_ms=4.65,  # strong unequal dual-bank muscle interference!
        pipe0_tau_ms=7.50,
        pipe1_tau_ms=8.45,
        pipe_fwd_gain=0.34,
        pipe_fb_gain=0.30,
        pipe_damp_hz=3100.0,
        xpipe_mix=0.28,  # H-pipe bass coupling
        xpipe_delay_ms=1.65,
        rasp_gain=0.34,
        rasp_lo_hz=150.0,
        rasp_hi_hz=2800.0,
        crackle_gain=0.14,
        crackle_lo_hz=1200.0,
        crackle_hi_hz=6200.0,
        band_lo_hz=28.0,
        band_hi_hz=6400.0,
        exhaust_formants=(
            _formant_q(60.0, 1.1, 1.15),
            _formant_q(145.0, 1.3, 1.10),
            _formant_q(380.0, 1.4, 0.95),
            _formant_q(920.0, 1.5, 0.80),
        ),
        intake_gain=0.22,
        intake_formants=(_formant_q(130.0, 1.3, 0.90), _formant_q(400.0, 1.4, 0.85)),
        intake_rush_gain=0.07,
        mech_gain=0.056,
        sub_punch_gain=0.40,
        sub_bass_boost_hz=58.0,
        sub_bass_gain=0.55,
        sat_drive=1.92,
        sat_asym=0.15,
        post_formants=(_formant_q(420.0, 1.2, 0.45),),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v8_cross_low(rng: np.random.Generator) -> np.ndarray:
    """2100 RPM Cross-Plane V8 (Vela GT / Muscle) thunderous low-end grunt."""
    cfg = EnginePhysConfig(
        rpm=2100.0,
        cycle_deg=720.0,
        cylinders=_CYL_V8_CROSS,
        bank_symmetric=False,
        blowdown_tau_ms=1.35,
        blowdown_exp=1.28,
        shock_mix=0.70,
        rarefaction_depth=0.40,
        rarefaction_tau_mult=2.50,
        rad_corner_hz=1500.0,
        rad_tilt_exp=1.08,
        energy_jitter_frac=0.038,
        time_jitter_ms=0.14,
        tau_jitter_frac=0.034,
        bank0_delay_ms=1.80,
        bank1_delay_ms=3.80,
        pipe0_tau_ms=5.20,
        pipe1_tau_ms=5.95,
        pipe_fwd_gain=0.35,
        pipe_fb_gain=0.31,
        pipe_damp_hz=4000.0,
        xpipe_mix=0.28,
        xpipe_delay_ms=1.35,
        rasp_gain=0.36,
        rasp_lo_hz=210.0,
        rasp_hi_hz=4000.0,
        crackle_gain=0.18,
        crackle_lo_hz=1600.0,
        crackle_hi_hz=8200.0,
        band_lo_hz=32.0,
        band_hi_hz=8400.0,
        exhaust_formants=(
            _formant_q(85.0, 1.1, 1.10),
            _formant_q(210.0, 1.3, 1.10),
            _formant_q(520.0, 1.4, 1.00),
            _formant_q(1240.0, 1.5, 0.90),
        ),
        intake_gain=0.24,
        intake_formants=(_formant_q(200.0, 1.3, 0.90), _formant_q(640.0, 1.4, 0.85)),
        intake_rush_gain=0.09,
        mech_gain=0.060,
        sub_punch_gain=0.36,
        sub_bass_boost_hz=72.0,
        sub_bass_gain=0.48,
        sat_drive=1.98,
        sat_asym=0.15,
        post_formants=(_formant_q(640.0, 1.2, 0.45),),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v8_cross_4200(rng: np.random.Generator) -> np.ndarray:
    """4200 RPM Cross-Plane V8 (Vela GT / Muscle) roaring pull."""
    cfg = EnginePhysConfig(
        rpm=4200.0,
        cycle_deg=720.0,
        cylinders=_CYL_V8_CROSS,
        bank_symmetric=False,
        blowdown_tau_ms=0.68,
        blowdown_exp=1.25,
        shock_mix=0.80,
        rarefaction_depth=0.36,
        rarefaction_tau_mult=2.35,
        rad_corner_hz=2150.0,
        rad_tilt_exp=1.18,
        energy_jitter_frac=0.034,
        time_jitter_ms=0.11,
        tau_jitter_frac=0.030,
        bank0_delay_ms=1.55,
        bank1_delay_ms=3.10,
        pipe0_tau_ms=3.30,
        pipe1_tau_ms=3.85,
        pipe_fwd_gain=0.35,
        pipe_fb_gain=0.32,
        pipe_damp_hz=5200.0,
        xpipe_mix=0.26,
        xpipe_delay_ms=1.05,
        rasp_gain=0.38,
        rasp_lo_hz=300.0,
        rasp_hi_hz=5600.0,
        crackle_gain=0.22,
        crackle_lo_hz=2100.0,
        crackle_hi_hz=10400.0,
        band_lo_hz=38.0,
        band_hi_hz=10600.0,
        exhaust_formants=(
            _formant_q(140.0, 1.2, 0.95),
            _formant_q(360.0, 1.3, 1.05),
            _formant_q(920.0, 1.5, 1.10),
            _formant_q(1980.0, 1.5, 0.95),
        ),
        intake_gain=0.26,
        intake_formants=(_formant_q(310.0, 1.3, 0.90), _formant_q(940.0, 1.4, 0.95)),
        intake_rush_gain=0.10,
        mech_gain=0.068,
        sub_punch_gain=0.28,
        sub_bass_boost_hz=72.0,
        sub_bass_gain=0.38,
        sat_drive=2.06,
        sat_asym=0.15,
        post_formants=(_formant_q(1180.0, 1.3, 0.50),),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v8_cross_6800(rng: np.random.Generator) -> np.ndarray:
    """6800 RPM Cross-Plane V8 (NASCAR / GT3 V8) roaring top-end thunder."""
    cfg = EnginePhysConfig(
        rpm=6800.0,
        cycle_deg=720.0,
        cylinders=_CYL_V8_CROSS,
        bank_symmetric=False,
        blowdown_tau_ms=0.38,
        blowdown_exp=1.20,
        shock_mix=0.88,
        rarefaction_depth=0.31,
        rarefaction_tau_mult=2.18,
        rad_corner_hz=2850.0,
        rad_tilt_exp=1.25,
        energy_jitter_frac=0.028,
        time_jitter_ms=0.09,
        tau_jitter_frac=0.026,
        bank0_delay_ms=1.35,
        bank1_delay_ms=2.55,
        pipe0_tau_ms=2.20,
        pipe1_tau_ms=2.55,
        pipe_fwd_gain=0.36,
        pipe_fb_gain=0.34,
        pipe_damp_hz=7000.0,
        xpipe_mix=0.28,
        xpipe_delay_ms=0.85,
        rasp_gain=0.38,
        rasp_lo_hz=480.0,
        rasp_hi_hz=7600.0,
        crackle_gain=0.26,
        crackle_lo_hz=2800.0,
        crackle_hi_hz=13400.0,
        band_lo_hz=44.0,
        band_hi_hz=13600.0,
        exhaust_formants=(
            _formant_q(230.0, 1.2, 0.85),
            _formant_q(680.0, 1.4, 1.05),
            _formant_q(1650.0, 1.5, 1.15),
            _formant_q(3250.0, 1.6, 1.05),
        ),
        intake_gain=0.28,
        intake_formants=(_formant_q(520.0, 1.3, 0.90), _formant_q(1580.0, 1.5, 1.05)),
        intake_rush_gain=0.12,
        intake_rush_band=(1400.0, 9200.0),
        mech_gain=0.078,
        sub_punch_gain=0.22,
        sub_bass_boost_hz=58.0,
        sub_bass_gain=0.30,
        sat_drive=2.14,
        sat_asym=0.16,
        post_formants=(_formant_q(1850.0, 1.3, 0.55), _formant_q(3500.0, 1.4, 0.50)),
    )
    return _synth_physical_engine(cfg, rng)


# 7) Flat-Plane V8 (Fiamma / Tornado GT3) ----------------------------------------------------------


def synth_eng_v8_flat_1100(rng: np.random.Generator) -> np.ndarray:
    """1100 RPM Flat-Plane V8 (Fiamma / GT3) crisp Italian equal-length idle."""
    cfg = EnginePhysConfig(
        rpm=1100.0,
        cycle_deg=720.0,
        cylinders=_CYL_V8_FLAT,
        blowdown_tau_ms=1.88,
        blowdown_exp=1.24,
        shock_mix=0.72,
        rarefaction_depth=0.36,
        rarefaction_tau_mult=2.40,
        rad_corner_hz=1750.0,
        rad_tilt_exp=1.14,
        energy_jitter_frac=0.038,
        time_jitter_ms=0.14,
        tau_jitter_frac=0.032,
        bank0_delay_ms=1.65,
        bank1_delay_ms=1.92,
        pipe0_tau_ms=5.15,
        pipe1_tau_ms=5.42,
        pipe_fwd_gain=0.33,
        pipe_fb_gain=0.30,
        pipe_damp_hz=5000.0,
        xpipe_mix=0.25,
        xpipe_delay_ms=0.72,
        rasp_gain=0.30,
        rasp_lo_hz=280.0,
        rasp_hi_hz=4400.0,
        crackle_gain=0.17,
        crackle_lo_hz=2000.0,
        crackle_hi_hz=9200.0,
        band_lo_hz=36.0,
        band_hi_hz=9800.0,
        exhaust_formants=(
            _formant_q(74.0, 1.2, 0.90),
            _formant_q(240.0, 1.3, 0.95),
            _formant_q(820.0, 1.5, 1.05),
            _formant_q(1820.0, 1.5, 0.90),
        ),
        intake_gain=0.26,
        intake_formants=(_formant_q(220.0, 1.3, 0.85), _formant_q(740.0, 1.4, 0.90)),
        intake_rush_gain=0.08,
        mech_gain=0.074,
        sub_punch_gain=0.28,
        sub_bass_boost_hz=74.0,
        sub_bass_gain=0.36,
        sat_drive=1.74,
        sat_asym=0.13,
        post_formants=(_formant_q(1100.0, 1.2, 0.45),),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v8_flat_low(rng: np.random.Generator) -> np.ndarray:
    """2600 RPM Flat-Plane V8 (Fiamma / GT3) sharp flat-plane pull."""
    cfg = EnginePhysConfig(
        rpm=2600.0,
        cycle_deg=720.0,
        cylinders=_CYL_V8_FLAT,
        blowdown_tau_ms=0.80,
        blowdown_exp=1.23,
        shock_mix=0.80,
        rarefaction_depth=0.33,
        rarefaction_tau_mult=2.30,
        rad_corner_hz=2250.0,
        rad_tilt_exp=1.20,
        energy_jitter_frac=0.034,
        time_jitter_ms=0.11,
        tau_jitter_frac=0.030,
        bank0_delay_ms=1.55,
        bank1_delay_ms=1.78,
        pipe0_tau_ms=3.45,
        pipe1_tau_ms=3.65,
        pipe_fwd_gain=0.34,
        pipe_fb_gain=0.32,
        pipe_damp_hz=6000.0,
        xpipe_mix=0.26,
        xpipe_delay_ms=0.65,
        rasp_gain=0.32,
        rasp_lo_hz=380.0,
        rasp_hi_hz=5600.0,
        crackle_gain=0.21,
        crackle_lo_hz=2400.0,
        crackle_hi_hz=11000.0,
        band_lo_hz=42.0,
        band_hi_hz=11600.0,
        exhaust_formants=(
            _formant_q(174.0, 1.2, 0.85),
            _formant_q(520.0, 1.4, 1.00),
            _formant_q(1340.0, 1.5, 1.15),
            _formant_q(2600.0, 1.6, 1.00),
        ),
        intake_gain=0.28,
        intake_formants=(_formant_q(320.0, 1.3, 0.90), _formant_q(1080.0, 1.5, 0.95)),
        intake_rush_gain=0.10,
        mech_gain=0.078,
        sub_punch_gain=0.24,
        sub_bass_boost_hz=86.0,
        sub_bass_gain=0.32,
        sat_drive=1.86,
        sat_asym=0.13,
        post_formants=(_formant_q(1450.0, 1.3, 0.50),),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v8_flat_5500(rng: np.random.Generator) -> np.ndarray:
    """5200 RPM Flat-Plane V8 (Fiamma / GT3) snarling Ferrari-style V8 wail."""
    cfg = EnginePhysConfig(
        rpm=5200.0,
        cycle_deg=720.0,
        cylinders=_CYL_V8_FLAT,
        blowdown_tau_ms=0.36,
        blowdown_exp=1.20,
        shock_mix=0.88,
        rarefaction_depth=0.29,
        rarefaction_tau_mult=2.14,
        rad_corner_hz=2950.0,
        rad_tilt_exp=1.26,
        energy_jitter_frac=0.028,
        time_jitter_ms=0.09,
        tau_jitter_frac=0.026,
        bank0_delay_ms=1.35,
        bank1_delay_ms=1.55,
        pipe0_tau_ms=2.10,
        pipe1_tau_ms=2.22,
        pipe_fwd_gain=0.35,
        pipe_fb_gain=0.34,
        pipe_damp_hz=7600.0,
        xpipe_mix=0.28,
        xpipe_delay_ms=0.55,
        rasp_gain=0.34,
        rasp_lo_hz=580.0,
        rasp_hi_hz=7600.0,
        crackle_gain=0.25,
        crackle_lo_hz=2800.0,
        crackle_hi_hz=13800.0,
        band_lo_hz=48.0,
        band_hi_hz=14200.0,
        exhaust_formants=(
            _formant_q(346.0, 1.2, 0.80),
            _formant_q(1040.0, 1.5, 1.10),
            _formant_q(2250.0, 1.6, 1.25),
            _formant_q(3900.0, 1.6, 1.10),
        ),
        intake_gain=0.29,
        intake_formants=(_formant_q(520.0, 1.3, 0.90), _formant_q(1600.0, 1.5, 1.05)),
        intake_rush_gain=0.11,
        intake_rush_band=(1500.0, 9600.0),
        mech_gain=0.085,
        sub_punch_gain=0.20,
        sub_bass_boost_hz=86.0,
        sub_bass_gain=0.26,
        sat_drive=2.00,
        sat_asym=0.14,
        post_formants=(_formant_q(2300.0, 1.3, 0.55), _formant_q(4050.0, 1.4, 0.50)),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v8_flat_8000(rng: np.random.Generator) -> np.ndarray:
    """8000 RPM Flat-Plane V8 (Fiamma / GT3) blistering 8500-RPM Inconel scream."""
    cfg = EnginePhysConfig(
        rpm=8000.0,
        cycle_deg=720.0,
        cylinders=_CYL_V8_FLAT,
        blowdown_tau_ms=0.22,
        blowdown_exp=1.16,
        shock_mix=0.94,
        rarefaction_depth=0.25,
        rarefaction_tau_mult=2.00,
        rad_corner_hz=3550.0,
        rad_tilt_exp=1.30,
        energy_jitter_frac=0.025,
        time_jitter_ms=0.08,
        tau_jitter_frac=0.024,
        bank0_delay_ms=1.18,
        bank1_delay_ms=1.35,
        pipe0_tau_ms=1.48,
        pipe1_tau_ms=1.58,
        pipe_fwd_gain=0.36,
        pipe_fb_gain=0.35,
        pipe_damp_hz=9200.0,
        xpipe_mix=0.30,
        xpipe_delay_ms=0.45,
        rasp_gain=0.35,
        rasp_lo_hz=820.0,
        rasp_hi_hz=9600.0,
        crackle_gain=0.28,
        crackle_lo_hz=3400.0,
        crackle_hi_hz=15500.0,
        band_lo_hz=52.0,
        band_hi_hz=15600.0,
        exhaust_formants=(
            _formant_q(533.0, 1.2, 0.75),
            _formant_q(1600.0, 1.5, 1.15),
            _formant_q(3150.0, 1.6, 1.30),
            _formant_q(5200.0, 1.6, 1.15),
        ),
        intake_gain=0.31,
        intake_formants=(_formant_q(840.0, 1.4, 0.90), _formant_q(2600.0, 1.5, 1.10)),
        intake_rush_gain=0.12,
        intake_rush_band=(1900.0, 11200.0),
        mech_gain=0.092,
        sub_punch_gain=0.17,
        sub_bass_boost_hz=68.0,
        sub_bass_gain=0.24,
        sat_drive=2.12,
        sat_asym=0.15,
        post_formants=(_formant_q(3200.0, 1.3, 0.55), _formant_q(5300.0, 1.4, 0.55)),
    )
    return _synth_physical_engine(cfg, rng)


# 8) Supercharged Cross-Plane V8 (Hellhound) -------------------------------------------------------


def _make_roots_blower_layer(
    lobe_hz: float,
    whine_level: float,
    air_level: float,
) -> Callable[[np.ndarray, float, float, np.random.Generator], np.ndarray]:
    """Create a 100%-periodic crank-locked Roots / twin-screw supercharger whine layer."""

    def _layer(t: np.ndarray, duration_s: float, f_crank: float, rng_local: np.random.Generator) -> np.ndarray:
        n = t.shape[0]
        f_lobe = _exact_cycle_freq(lobe_hz, duration_s)
        f_sub = _exact_cycle_freq(lobe_hz * 0.5, duration_s)
        f_cr = _exact_cycle_freq(f_crank, duration_s)
        f_m1 = _exact_cycle_freq(1.333, duration_s)
        f_m2 = _exact_cycle_freq(3.333, duration_s)

        belt_fm = (
            0.26 * np.sin(2.0 * math.pi * f_m1 * t)
            + 0.11 * np.sin(2.0 * math.pi * f_m2 * t + 0.6)
            + 0.06 * np.sin(2.0 * math.pi * f_cr * t + 1.4)
        )
        whine = (
            0.22 * np.sin(2.0 * math.pi * f_sub * t + 0.5 * belt_fm + 0.3)
            + 0.84 * np.sin(2.0 * math.pi * f_lobe * t + belt_fm)
            + 0.18 * np.sin(2.0 * math.pi * _exact_cycle_freq(f_lobe + f_sub, duration_s) * t + 1.5 * belt_fm + 0.9)
            + 0.36 * np.sin(2.0 * math.pi * (2.0 * f_lobe) * t + 2.0 * belt_fm + 0.5)
            + 0.13 * np.sin(2.0 * math.pi * _exact_cycle_freq(f_lobe - f_cr, duration_s) * t + belt_fm + 0.4)
            + 0.13 * np.sin(2.0 * math.pi * _exact_cycle_freq(f_lobe + f_cr, duration_s) * t + belt_fm + 2.0)
        )
        if 3.0 * f_lobe < 18500.0:
            whine = whine + 0.12 * np.sin(2.0 * math.pi * (3.0 * f_lobe) * t + 3.0 * belt_fm + 1.3)
        whine = np.tanh(whine * 1.18)

        # Pressurized twin-screw blower housing air rush
        hi_cut = min(14500.0, f_lobe * 2.8)
        lo_cut = max(1400.0, f_lobe * 0.55)
        sc_air = _circular_fft_shape(
            rng_local.standard_normal(n),
            lambda f: _bandpass_curve(f, lo_cut, hi_cut, order=2.0)
            * _resonator_bank(
                f,
                (
                    _formant_q(f_lobe, 1.7, 1.3),
                    _formant_q(min(13000.0, 2.0 * f_lobe), 1.6, 0.9),
                ),
            ),
        )
        sc_air /= float(np.sqrt(np.mean(sc_air * sc_air))) + 1e-9
        return whine_level * whine + air_level * sc_air

    return _layer


def synth_eng_sc_v8_whine(rng: np.random.Generator) -> np.ndarray:
    """4200 RPM Supercharged Cross-Plane V8 (Hellhound) + prominent Roots blower scream."""
    cfg = EnginePhysConfig(
        rpm=4200.0,
        cycle_deg=720.0,
        cylinders=_CYL_V8_CROSS,
        bank_symmetric=False,
        blowdown_tau_ms=0.68,
        blowdown_exp=1.26,
        shock_mix=0.78,
        rarefaction_depth=0.36,
        rarefaction_tau_mult=2.35,
        rad_corner_hz=2050.0,
        rad_tilt_exp=1.16,
        energy_jitter_frac=0.034,
        time_jitter_ms=0.11,
        tau_jitter_frac=0.030,
        bank0_delay_ms=1.55,
        bank1_delay_ms=3.15,
        pipe0_tau_ms=3.35,
        pipe1_tau_ms=3.90,
        pipe_fwd_gain=0.35,
        pipe_fb_gain=0.32,
        pipe_damp_hz=5000.0,
        xpipe_mix=0.26,
        xpipe_delay_ms=1.10,
        rasp_gain=0.35,
        rasp_lo_hz=280.0,
        rasp_hi_hz=5000.0,
        crackle_gain=0.20,
        crackle_lo_hz=1900.0,
        crackle_hi_hz=9600.0,
        band_lo_hz=36.0,
        band_hi_hz=9600.0,
        exhaust_formants=(
            _formant_q(140.0, 1.2, 0.95),
            _formant_q(350.0, 1.3, 1.00),
            _formant_q(900.0, 1.5, 1.00),
            _formant_q(1850.0, 1.5, 0.85),
        ),
        intake_gain=0.18,
        intake_formants=(_formant_q(280.0, 1.3, 0.85), _formant_q(840.0, 1.4, 0.85)),
        intake_rush_gain=0.08,
        mech_gain=0.064,
        sub_punch_gain=0.28,
        sub_bass_boost_hz=72.0,
        sub_bass_gain=0.38,
        sat_drive=2.00,
        sat_asym=0.15,
    )
    return _synth_physical_engine(
        cfg,
        rng,
        extra_layer_fn=_make_roots_blower_layer(lobe_hz=2800.0, whine_level=0.86, air_level=0.26),
    )


def synth_eng_sc_v8_6800(rng: np.random.Generator) -> np.ndarray:
    """6800 RPM Supercharged Cross-Plane V8 (Hellhound) redline V8 + jet-screaming blower whine."""
    cfg = EnginePhysConfig(
        rpm=6800.0,
        cycle_deg=720.0,
        cylinders=_CYL_V8_CROSS,
        bank_symmetric=False,
        blowdown_tau_ms=0.38,
        blowdown_exp=1.20,
        shock_mix=0.86,
        rarefaction_depth=0.31,
        rarefaction_tau_mult=2.18,
        rad_corner_hz=2800.0,
        rad_tilt_exp=1.24,
        energy_jitter_frac=0.028,
        time_jitter_ms=0.09,
        tau_jitter_frac=0.026,
        bank0_delay_ms=1.35,
        bank1_delay_ms=2.55,
        pipe0_tau_ms=2.20,
        pipe1_tau_ms=2.55,
        pipe_fwd_gain=0.36,
        pipe_fb_gain=0.34,
        pipe_damp_hz=7000.0,
        xpipe_mix=0.28,
        xpipe_delay_ms=0.85,
        rasp_gain=0.36,
        rasp_lo_hz=460.0,
        rasp_hi_hz=7400.0,
        crackle_gain=0.24,
        crackle_lo_hz=2600.0,
        crackle_hi_hz=13200.0,
        band_lo_hz=44.0,
        band_hi_hz=13400.0,
        exhaust_formants=(
            _formant_q(226.0, 1.2, 0.85),
            _formant_q(660.0, 1.4, 1.00),
            _formant_q(1600.0, 1.5, 1.05),
            _formant_q(3100.0, 1.6, 0.95),
        ),
        intake_gain=0.18,
        intake_formants=(_formant_q(480.0, 1.3, 0.85), _formant_q(1450.0, 1.5, 0.95)),
        intake_rush_gain=0.09,
        mech_gain=0.074,
        sub_punch_gain=0.22,
        sub_bass_boost_hz=58.0,
        sub_bass_gain=0.30,
        sat_drive=2.10,
        sat_asym=0.15,
    )
    # Exact proportional lobe scaling: 2800 * (6800 / 4200) = 4533.3 Hz for seamless crossfade!
    return _synth_physical_engine(
        cfg,
        rng,
        extra_layer_fn=_make_roots_blower_layer(lobe_hz=4534.0, whine_level=0.96, air_level=0.30),
    )


# ---- Visceral Forced-Induction, Drivetrain, Exhaust & Tyre FX Stems (7 Stems) --------------------


def synth_turbo_spool_loop(rng: np.random.Generator) -> np.ndarray:
    """
    1.5 s seamless Garrett / BorgWarner turbocharger compressor wheel whistle + pressurized
    charge-pipe intake air rush (designed to pitch 0.6x-1.7x for authentic jet-turbine spool):
      - Dual blade-pass tones at 3400 Hz & 6800 Hz (+ subtle twin-wheel/splitter detune at 3428 Hz,
        5100 Hz half-order aero swirl, and shaft-speed sidebands).
      - Pressurized charge-pipe aerodynamic intake air rush (1800-6500 Hz) with compressor volute body.
    """
    dur = LOOP_DURATION_S
    n = int(round(SAMPLE_RATE * dur))
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE

    f_bp1 = _exact_cycle_freq(3400.0, dur)       # primary compressor blade-pass (5100 exact cycles)
    f_bp1b = _exact_cycle_freq(3428.0, dur)      # twin-turbo / splitter-blade subtle shimmer
    f_bp15 = _exact_cycle_freq(5100.0, dur)      # 1.5x diffuser vane aero tone
    f_bp2 = _exact_cycle_freq(6800.0, dur)       # 2nd blade-pass harmonic (10200 exact cycles)
    f_bp3 = _exact_cycle_freq(10200.0, dur)      # 3rd blade-pass turbine glint
    f_shaft = _exact_cycle_freq(284.0, dur)      # ~17,000-RPM sub-harmonic bearing/shaft sideband

    # Organic exact-cycle micro-flutter of spinning compressor wheel
    f_m1 = _exact_cycle_freq(2.0, dur)
    f_m2 = _exact_cycle_freq(4.0, dur)
    f_m3 = _exact_cycle_freq(6.667, dur)
    fm = (
        0.24 * np.sin(2.0 * math.pi * f_m1 * t + 0.4)
        + 0.11 * np.sin(2.0 * math.pi * f_m2 * t + 1.8)
        + 0.05 * np.sin(2.0 * math.pi * f_m3 * t + 0.9)
    )
    am = 1.0 + 0.05 * np.sin(2.0 * math.pi * f_m1 * t + 1.1) + 0.025 * np.sin(2.0 * math.pi * f_m2 * t)

    whistle = (
        1.00 * np.sin(2.0 * math.pi * f_bp1 * t + fm)
        + 0.34 * np.sin(2.0 * math.pi * f_bp1b * t - 0.8 * fm + 1.2)
        + 0.16 * np.sin(2.0 * math.pi * f_bp15 * t + 1.5 * fm + 0.5)
        + 0.48 * np.sin(2.0 * math.pi * f_bp2 * t + 2.0 * fm + 0.7)
        + 0.14 * np.sin(2.0 * math.pi * f_bp3 * t + 3.0 * fm + 1.9)
        + 0.10 * np.sin(2.0 * math.pi * _exact_cycle_freq(f_bp1 - f_shaft, dur) * t + fm + 0.3)
        + 0.10 * np.sin(2.0 * math.pi * _exact_cycle_freq(f_bp1 + f_shaft, dur) * t + fm + 2.1)
    ) * am
    whine = _asymmetric_saturate(whistle, drive=1.22, asym=0.05, dry_mix=0.45)

    # Pressurized charge-pipe / cone-filter aerodynamic intake air rush (1800-6500 Hz)
    rush = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 1800.0, 6500.0, order=2.2)
        * _resonator_bank(
            f,
            (
                _formant_q(2450.0, 1.4, 1.1),
                _formant_q(3400.0, 1.7, 1.5),
                _formant_q(5400.0, 1.5, 0.9),
            ),
        ),
    )
    rush /= float(np.sqrt(np.mean(rush * rush))) + 1e-9

    # Subtle pressurized low-mid intake cone-filter whoosh body (1200-2600 Hz)
    whoosh = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 1200.0, 2800.0, order=2.0),
    )
    whoosh /= float(np.sqrt(np.mean(whoosh * whoosh))) + 1e-9

    # Slow aerodynamic turbulence shimmer on intake rush (100% periodic)
    turb_mod = _circular_fft_shape(rng.standard_normal(n), lambda f: _bandpass_curve(f, 2.0, 14.0, order=2.0))
    turb_mod = 1.0 + 0.14 * (turb_mod / (float(np.std(turb_mod)) + 1e-9))

    whine_rms = float(np.sqrt(np.mean(whine * whine))) + 1e-9
    sig = whine + (0.72 * rush + 0.24 * whoosh) * turb_mod * whine_rms
    sig = _circular_fft_shape(sig, lambda f: _bandpass_curve(f, 950.0, 14500.0, order=2.0))
    return _finalize_loop(sig, target_rms_dbfs=-13.0)


def synth_turbo_flutter_bov(rng: np.random.Generator) -> np.ndarray:
    """
    1.1 s one-shot super crisp, loud, realistic 6-pulse compressor-surge flutter
    ("stu-tu-tu-tu-tu-tu") with resonant aluminum hard-pipe waveguide ring!
    """
    dur = 1.1
    n = int(round(SAMPLE_RATE * dur))
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE

    # 6 crisp, punchy decelerating compressor-stall pulses with deep troughs between chops
    pulses = [
        # (start_s, tau_s, amp, pitch_hz)
        (0.010, 0.012, 1.38, 2750.0),  # razor-crisp "STU-"
        (0.098, 0.014, 1.16, 2380.0),  # "-tu-"
        (0.205, 0.016, 0.96, 2060.0),  # "-tu-"
        (0.332, 0.019, 0.78, 1780.0),  # "-tu-"
        (0.480, 0.022, 0.58, 1520.0),  # "-tu-"
        (0.655, 0.027, 0.36, 1300.0),  # "-tu"
    ]

    chop_env = np.zeros(n, dtype=np.float64)
    blade_chirp = np.zeros(n, dtype=np.float64)
    al_ring = np.zeros(n, dtype=np.float64)

    for t0, tau, amp, f_center in pulses:
        dt = np.maximum(t - t0, 0.0)
        gate = (t >= t0).astype(np.float64)
        u = dt / tau
        p_env = amp * (u ** 0.65) * np.exp(-u) * ((math.e / 0.65) ** 0.65) * gate
        chop_env += p_env

        # Per-pulse descending compressor blade-pass chirp
        f_inst = f_center * (0.72 + 0.38 * np.exp(-dt / (tau * 1.20)))
        phi = 2.0 * math.pi * np.cumsum(f_inst * gate) / SAMPLE_RATE
        blade_chirp += p_env * (
            0.44 * np.sin(phi)
            + 0.24 * np.sin(2.0 * phi + 0.5)
            + 0.11 * np.sin(3.0 * phi + 1.2)
        )

        # Resonant aluminum intercooler intake-pipe modal ring excited by each surge chop
        ring_env = amp * np.exp(-dt / (tau * 1.65)) * np.clip(dt / 0.0012, 0.0, 1.0) * gate
        al_ring += ring_env * (
            0.34 * np.sin(2.0 * math.pi * 1245.0 * dt + 0.2)
            + 0.26 * np.sin(2.0 * math.pi * 1870.0 * dt + 1.1)
            + 0.18 * np.sin(2.0 * math.pi * 2490.0 * dt + 2.0)
        )

    # Low pressurized charge-pipe bleed underneath the 6 sharp chops
    bleed_env = 0.05 * np.exp(-t / 0.28) * np.clip(t / 0.008, 0.0, 1.0)
    full_env = chop_env + bleed_env

    # Multi-band pressurized turbulent intake air
    air_hi = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 2200.0, 10200.0, order=2.5)
        * _resonator_bank(f, (_formant_q(3550.0, 1.8, 1.4), _formant_q(6000.0, 1.7, 1.1))),
    )
    air_mid = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 820.0, 3900.0, order=2.5)
        * _resonator_bank(f, (_formant_q(1480.0, 1.9, 1.6), _formant_q(2320.0, 1.8, 1.3))),
    )
    air_lo = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 340.0, 1200.0, order=2.0)
        * _resonator_bank(f, (_formant_q(620.0, 1.6, 1.2),)),
    )
    for arr in (air_hi, air_mid, air_lo):
        arr /= float(np.sqrt(np.mean(arr * arr))) + 1e-9

    hi_w = np.exp(-t / 0.28)
    air = (0.86 * hi_w * air_hi + 1.15 * air_mid + 0.36 * air_lo) * full_env

    raw = air + 0.52 * blade_chirp + 0.34 * al_ring
    # Hollow aluminum dose-pipe waveguide comb (~625 Hz / 1250 Hz / 1875 Hz!)
    piped = _circular_fft_shape(
        raw,
        lambda f: _waveguide_pipe_tf(
            f,
            delay_ms=0.15,
            pipe_tau_ms=1.60,
            fwd_gain=0.38,
            fb_gain=0.52,
            damp_hz=6800.0,
        )
        * _bandpass_curve(f, 280.0, 11800.0, order=2.0),
    )
    piped = _asymmetric_saturate(piped, drive=1.48, asym=0.09, dry_mix=0.32)
    return _finalize_oneshot(piped, target_rms_dbfs=-12.2, fade_in_ms=1.5, fade_out_ms=60.0)


def synth_exhaust_backfire_pop(rng: np.random.Generator) -> np.ndarray:
    """
    0.55 s one-shot punchy shotgun exhaust detonation + chest-thumping sub-bass shockwave +
    rapid double-crackle tail + titanium tailpipe metallic waveguide ring.
    """
    dur = 0.55
    n = int(round(SAMPLE_RATE * dur))
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE

    crack_src1 = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 220.0, 15000.0, order=2.0)
        * _resonator_bank(
            f,
            (_formant_q(520.0, 1.4, 1.3), _formant_q(1850.0, 1.5, 1.5), _formant_q(4600.0, 1.5, 1.2)),
        ),
    )
    crack_src1 /= float(np.sqrt(np.mean(crack_src1 * crack_src1))) + 1e-9

    crack_src2 = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 280.0, 13200.0, order=2.0)
        * _resonator_bank(f, (_formant_q(680.0, 1.5, 1.3), _formant_q(2200.0, 1.5, 1.4))),
    )
    crack_src2 /= float(np.sqrt(np.mean(crack_src2 * crack_src2))) + 1e-9

    # 1. Primary violent shotgun detonation at t = 5 ms + chest-thumping sub-bass shockwave
    t1 = np.maximum(t - 0.005, 0.0)
    g1 = (t >= 0.005).astype(np.float64)
    f_th1 = 40.0 + 185.0 * np.exp(-t1 / 0.009)
    phi1 = 2.0 * math.pi * np.cumsum(f_th1 * g1) / SAMPLE_RATE
    thump1 = np.sin(phi1) * np.exp(-t1 / 0.048) * np.clip(t1 / 0.0005, 0.0, 1.0) * g1
    # Extra sub-bass pressure wave punch (54 Hz)
    sub_shock = 0.85 * np.sin(2.0 * math.pi * 54.0 * t1) * np.exp(-t1 / 0.052) * np.clip(t1 / 0.0010, 0.0, 1.0) * g1
    shock1 = (t1 / 0.0009) ** 0.62 * np.exp(-t1 / 0.0009) * g1
    crack1 = crack_src1 * (2.05 * np.exp(-t1 / 0.010) + 0.52 * np.exp(-t1 / 0.036)) * g1

    # 2. Rapid double-crackle tail: pop #1 at t = 74 ms, pop #2 at t = 138 ms
    t2 = np.maximum(t - 0.074, 0.0)
    g2 = (t >= 0.074).astype(np.float64)
    f_th2 = 56.0 + 145.0 * np.exp(-t2 / 0.008)
    phi2 = 2.0 * math.pi * np.cumsum(f_th2 * g2) / SAMPLE_RATE
    thump2 = 0.72 * np.sin(phi2) * np.exp(-t2 / 0.028) * np.clip(t2 / 0.0007, 0.0, 1.0) * g2
    crack2 = 1.18 * crack_src2 * np.exp(-t2 / 0.012) * g2

    t3 = np.maximum(t - 0.138, 0.0)
    g3 = (t >= 0.138).astype(np.float64)
    f_th3 = 64.0 + 120.0 * np.exp(-t3 / 0.007)
    phi3 = 2.0 * math.pi * np.cumsum(f_th3 * g3) / SAMPLE_RATE
    thump3 = 0.48 * np.sin(phi3) * np.exp(-t3 / 0.022) * np.clip(t3 / 0.0007, 0.0, 1.0) * g3
    crack3 = 0.86 * crack_src1 * np.exp(-t3 / 0.011) * g3

    # 3. Titanium tailpipe metallic ring + hot exhaust-gas roar tail
    pipe_env = np.exp(-t1 / 0.130) * g1
    ti_ring = (
        0.42 * np.sin(2.0 * math.pi * 112.0 * t1)
        + 0.28 * np.sin(2.0 * math.pi * 240.0 * t1 + 0.7)
        + 0.20 * np.sin(2.0 * math.pi * 515.0 * t1 + 1.5)
        + 0.16 * np.sin(2.0 * math.pi * 1380.0 * t1 + 2.3) * np.exp(-t1 / 0.052)
        + 0.12 * np.sin(2.0 * math.pi * 2780.0 * t1 + 0.4) * np.exp(-t1 / 0.036)
    ) * pipe_env

    tail_roar = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 68.0, 1850.0, order=2.0),
    )
    tail_roar /= float(np.sqrt(np.mean(tail_roar * tail_roar))) + 1e-9
    tail_roar = tail_roar * (0.46 * np.exp(-t1 / 0.145) * g1)

    raw = (
        1.85 * thump1
        + sub_shock
        + 1.45 * shock1
        + 2.25 * crack1
        + thump2
        + crack2
        + thump3
        + crack3
        + ti_ring
        + tail_roar
    )
    piped = _circular_fft_shape(
        raw,
        lambda f: _waveguide_pipe_tf(
            f,
            delay_ms=0.1,
            pipe_tau_ms=3.85,
            fwd_gain=0.34,
            fb_gain=0.40,
            damp_hz=6000.0,
        ),
    )
    sat = _asymmetric_saturate(piped, drive=1.72, asym=0.14, dry_mix=0.45)
    return _finalize_oneshot(sat, target_rms_dbfs=-12.5, fade_in_ms=0.8, fade_out_ms=65.0)


def synth_gear_whine_straightcut(rng: np.random.Generator) -> np.ndarray:
    """
    1.5 s seamless authentic GT3 sequential straight-cut transmission whine:
      Tooth-mesh f0 = 1200.0 Hz (1800 exact cycles / 1.5 s) + trapezoidal tooth-contact harmonics
      up to 5th order, shaft runout FM/AM sidebands (±40 Hz, ±80 Hz), aluminum casing resonances,
      and needle-bearing mechanical carrier hiss.
    """
    dur = LOOP_DURATION_S
    n = int(round(SAMPLE_RATE * dur))
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    f_mesh = _exact_cycle_freq(1200.0, dur)
    f_shaft = _exact_cycle_freq(40.0, dur)
    f_load = _exact_cycle_freq(2.0, dur)

    am = (
        1.0
        + 0.10 * np.sin(2.0 * math.pi * f_shaft * t)
        + 0.045 * np.sin(2.0 * math.pi * (2.0 * f_shaft) * t + 0.9)
        + 0.025 * np.sin(2.0 * math.pi * f_load * t + 0.4)
    )
    pm = (
        0.16 * np.sin(2.0 * math.pi * f_shaft * t + 0.3)
        + 0.055 * np.sin(2.0 * math.pi * (2.0 * f_shaft) * t + 1.7)
    )

    whine = (
        1.00 * np.sin(2.0 * math.pi * f_mesh * t + pm)
        + 0.58 * np.sin(2.0 * math.pi * (2.0 * f_mesh) * t + 2.0 * pm + 0.65)
        + 0.32 * np.sin(2.0 * math.pi * (3.0 * f_mesh) * t + 3.0 * pm + 1.45)
        + 0.16 * np.sin(2.0 * math.pi * (4.0 * f_mesh) * t + 4.0 * pm + 2.15)
        + 0.08 * np.sin(2.0 * math.pi * (5.0 * f_mesh) * t + 5.0 * pm + 0.40)
        + 0.16 * np.sin(2.0 * math.pi * (0.5 * f_mesh) * t + 0.5 * pm + 0.8)
        + 0.19 * np.sin(2.0 * math.pi * (f_mesh - f_shaft) * t + 0.2)
        + 0.19 * np.sin(2.0 * math.pi * (f_mesh + f_shaft) * t + 1.9)
        + 0.10 * np.sin(2.0 * math.pi * (2.0 * f_mesh - f_shaft) * t + 0.7)
        + 0.10 * np.sin(2.0 * math.pi * (2.0 * f_mesh + f_shaft) * t + 2.4)
    ) * am

    whine = _asymmetric_saturate(whine, drive=1.55, asym=0.08)
    whine = _circular_fft_shape(
        whine,
        lambda f: _bandpass_curve(f, 420.0, 11800.0, order=2.0)
        * _resonator_bank(
            f,
            (
                _formant_q(1200.0, 2.2, 1.4),
                _formant_q(2400.0, 2.2, 1.3),
                _formant_q(3600.0, 2.2, 1.1),
                _formant_q(4850.0, 2.0, 0.85),
            ),
        ),
    )

    bearing = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 1800.0, 11200.0, order=2.0)
        * _resonator_bank(f, (_formant_q(2400.0, 1.6, 1.2), _formant_q(5200.0, 1.6, 1.0))),
    )
    bearing /= float(np.sqrt(np.mean(bearing * bearing))) + 1e-9
    whine_rms = float(np.sqrt(np.mean(whine * whine))) + 1e-9
    mesh_env = 0.74 + 0.26 * np.sin(2.0 * math.pi * f_shaft * t)

    return _finalize_loop(whine + 0.20 * whine_rms * bearing * mesh_env, target_rms_dbfs=-13.0)


def synth_tyre_scrub_dry(rng: np.random.Generator) -> np.ndarray:
    """
    1.5 s seamless realistic multi-harmonic sticky semi-slick rubber squeal/howl loop:
      Organic stick-slip tread block resonances (740, 1140, 1680, 2480 Hz) + phase-wandering
      semi-slick chirp ridges + dry-asphalt rubber tearing grit + 225 Hz toroidal tyre cavity hump.
    """
    dur = LOOP_DURATION_S
    n = int(round(SAMPLE_RATE * dur))
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE

    squeal_bands = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 500.0, 4400.0, order=2.0)
        * (
            3.0 / (1.0 + ((f - 740.0) / 52.0) ** 2)
            + 3.5 / (1.0 + ((f - 1140.0) / 76.0) ** 2)
            + 2.5 / (1.0 + ((f - 1680.0) / 112.0) ** 2)
            + 1.6 / (1.0 + ((f - 2480.0) / 175.0) ** 2)
        ),
    )
    squeal_bands /= float(np.sqrt(np.mean(squeal_bands * squeal_bands))) + 1e-9

    mod_raw = _circular_fft_shape(rng.standard_normal(n), lambda f: _bandpass_curve(f, 1.5, 10.5, order=2.0))
    mod = 1.0 + 0.24 * (mod_raw / (float(np.std(mod_raw)) + 1e-9))

    fm_noise1 = _circular_fft_shape(rng.standard_normal(n), lambda f: _bandpass_curve(f, 1.2, 8.0, order=2.0))
    fm_noise1 /= float(np.std(fm_noise1)) + 1e-9
    fm_noise2 = _circular_fft_shape(rng.standard_normal(n), lambda f: _bandpass_curve(f, 1.5, 9.5, order=2.0))
    fm_noise2 /= float(np.std(fm_noise2)) + 1e-9

    f1 = _exact_cycle_freq(880.0, dur)
    f2 = _exact_cycle_freq(1340.0, dur)
    f3 = _exact_cycle_freq(2120.0, dur)
    coherent = (
        0.24 * np.sin(2.0 * math.pi * f1 * t + 3.2 * fm_noise1)
        + 0.18 * np.sin(2.0 * math.pi * f2 * t + 3.8 * fm_noise2)
        + 0.10 * np.sin(2.0 * math.pi * f3 * t + 2.4 * fm_noise1 + 1.1)
    )

    scrub = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 140.0, 6600.0, order=2.0)
        * _resonator_bank(
            f,
            ((225.0, 38.0, 1.8), _formant_q(640.0, 1.4, 1.0), _formant_q(2900.0, 1.5, 0.9)),
        ),
    )
    scrub /= float(np.sqrt(np.mean(scrub * scrub))) + 1e-9

    sig = (0.90 * squeal_bands + coherent) * mod + 0.60 * scrub
    sig = _asymmetric_saturate(sig, drive=1.35, asym=0.05)
    return _finalize_loop(sig, target_rms_dbfs=-13.0)


def synth_tyre_spray_wet(rng: np.random.Generator) -> np.ndarray:
    """
    1.5 s seamless wet-asphalt hydroplane spray hiss + wheel-arch water splash loop.
    """
    dur = LOOP_DURATION_S
    n = int(round(SAMPLE_RATE * dur))

    spray_hi = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 2100.0, 14800.0, order=2.0)
        * _resonator_bank(f, (_formant_q(3600.0, 1.4, 1.3), _formant_q(7800.0, 1.5, 1.2))),
    )
    splash_mid = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 420.0, 2400.0, order=2.0)
        * _resonator_bank(f, (_formant_q(920.0, 1.4, 1.2),)),
    )
    puddle_lo = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 110.0, 520.0, order=2.0)
        * _resonator_bank(f, ((225.0, 42.0, 1.3),)),
    )
    for arr in (spray_hi, splash_mid, puddle_lo):
        arr /= float(np.sqrt(np.mean(arr * arr))) + 1e-9

    # Circular wheel-arch plastic-liner water splashes (125 randomized micro-slaps)
    drop_env = np.zeros(n, dtype=np.float64)
    ir_len = int(SAMPLE_RATE * 0.018)
    t_ir = np.arange(ir_len, dtype=np.float64) / SAMPLE_RATE
    ir_idx = np.arange(ir_len, dtype=np.int64)
    for _ in range(125):
        pos = int(rng.integers(0, n))
        tau_d = float(rng.uniform(0.0012, 0.0042))
        amp_d = float(rng.uniform(0.35, 1.25))
        pulse = amp_d * np.exp(-t_ir / tau_d) * np.clip(t_ir / 0.0003, 0.0, 1.0)
        drop_env[(pos + ir_idx) % n] += pulse

    drop_noise = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 900.0, 6800.0, order=2.0)
        * _resonator_bank(f, (_formant_q(1950.0, 1.5, 1.3),)),
    )
    drop_noise /= float(np.sqrt(np.mean(drop_noise * drop_noise))) + 1e-9
    droplets = drop_noise * (drop_env / (float(np.percentile(drop_env, 98)) + 1e-9))

    shimmer_hi = _circular_fft_shape(rng.standard_normal(n), lambda f: _bandpass_curve(f, 2.5, 12.0, order=2.0))
    shimmer_hi = 1.0 + 0.24 * (shimmer_hi / (float(np.std(shimmer_hi)) + 1e-9))

    shimmer_mid = _circular_fft_shape(rng.standard_normal(n), lambda f: _bandpass_curve(f, 1.5, 8.0, order=2.0))
    shimmer_mid = 1.0 + 0.28 * (shimmer_mid / (float(np.std(shimmer_mid)) + 1e-9))

    sig = (
        0.92 * spray_hi * shimmer_hi
        + 0.65 * splash_mid * shimmer_mid
        + 0.44 * droplets
        + 0.30 * puddle_lo
    )
    return _finalize_loop(sig, target_rms_dbfs=-13.0)


def synth_kerb_rumble_strip(rng: np.random.Generator) -> np.ndarray:
    """
    1.5 s seamless heavy hollow kerb block thumps + tyre air-cavity boom loop:
      48 exact kerb block strikes in 1.5 s (f0 = 32.0 Hz).
    """
    dur = LOOP_DURATION_S
    n = int(round(SAMPLE_RATE * dur))
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    f_kerb = 32.0
    num_strikes = int(round(f_kerb * dur))  # 48 exact strikes in 1.5 s
    stride = n / num_strikes  # 1500.0 samples per strike

    ir_len = int(SAMPLE_RATE * 0.115)
    t_ir = np.arange(ir_len, dtype=np.float64) / SAMPLE_RATE
    ir_idx = np.arange(ir_len, dtype=np.int64)

    # 1. Heavy unsprung-mass suspension thump (82 Hz -> 32 Hz)
    f_thump = 32.0 + 50.0 * np.exp(-t_ir / 0.011)
    phi_thump = 2.0 * math.pi * np.cumsum(f_thump) / SAMPLE_RATE
    thump = 1.25 * np.sin(phi_thump) * np.exp(-t_ir / 0.026) * np.clip(t_ir / 0.0012, 0.0, 1.0)

    # 2. Hollow chassis floor / suspension strut knock (116 Hz damped mode)
    strut = 0.62 * np.sin(2.0 * math.pi * 116.0 * t_ir + 0.3) * np.exp(-t_ir / 0.016) * np.clip(t_ir / 0.0008, 0.0, 1.0)

    # 3. 225 Hz toroidal tyre air-cavity resonance boom
    cavity = (
        0.68 * np.sin(2.0 * math.pi * 225.0 * t_ir)
        + 0.24 * np.sin(2.0 * math.pi * 450.0 * t_ir + 0.6)
    ) * np.exp(-t_ir / 0.022) * np.clip(t_ir / 0.0010, 0.0, 1.0)

    strike_ir = thump + strut + cavity
    grit_pulse = np.exp(-t_ir / 0.0085) * np.clip(t_ir / 0.0006, 0.0, 1.0)

    impulses = np.zeros(n, dtype=np.float64)
    grit_env = np.zeros(n, dtype=np.float64)

    for k in range(num_strikes):
        t_jit_samp = int(round(float(rng.normal(0.0, 0.00018 * SAMPLE_RATE))))
        start = (int(round(k * stride)) + t_jit_samp) % n
        amp_var = float(np.clip(rng.normal(1.0, 0.06), 0.86, 1.14))
        dest = (start + ir_idx) % n
        impulses[dest] += amp_var * strike_ir
        grit_env[dest] += amp_var * grit_pulse

    grit_noise = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 240.0, 2900.0, order=2.0)
        * _resonator_bank(
            f,
            ((225.0, 35.0, 1.4), _formant_q(780.0, 1.5, 1.1), _formant_q(1650.0, 1.5, 0.85)),
        ),
    )
    grit_noise /= float(np.sqrt(np.mean(grit_noise * grit_noise))) + 1e-9
    imp_rms = float(np.sqrt(np.mean(impulses * impulses))) + 1e-9

    hum = _harmonic_sum(t, dur, [(32.0, 0.26, 0.0), (64.0, 0.24, 0.4), (96.0, 0.14, 1.1)])
    sig = impulses + 0.82 * imp_rms * grit_noise * grit_env + 0.44 * imp_rms * hum
    sig = _asymmetric_saturate(sig, drive=1.48, asym=0.07, dry_mix=0.35)
    return _finalize_loop(sig, target_rms_dbfs=-13.0)


# ---- Stem Registry (37 Stems Exact) --------------------------------------------------------------


STEM_SPECS: list[StemSpec] = [
    # Flat-6 NA (GT3 RS) — 4 zones
    StemSpec(
        stem_id="eng_flat6_1000",
        filename="eng_flat6_1000.wav",
        category="engine",
        description="1000 RPM Flat-6 NA boxer idle loop (GT3 RS)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=1000,
        fundamental_hz=50.7,
        synth_fn=synth_eng_flat6_1000,
    ),
    StemSpec(
        stem_id="eng_flat6_low",
        filename="eng_flat6_low.wav",
        category="engine",
        description="2400 RPM Flat-6 NA punchy mid-low boxer growl loop (GT3 RS)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=2400,
        fundamental_hz=120.0,
        synth_fn=synth_eng_flat6_low,
    ),
    StemSpec(
        stem_id="eng_flat6_4000",
        filename="eng_flat6_4000.wav",
        category="engine",
        description="4800 RPM Flat-6 NA metallic flat-6 howl loop (GT3 RS)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=4800,
        fundamental_hz=240.0,
        synth_fn=synth_eng_flat6_4000,
    ),
    StemSpec(
        stem_id="eng_flat6_7800",
        filename="eng_flat6_7800.wav",
        category="engine",
        description="7800 RPM Flat-6 NA feral 9000-RPM GT3 RS titanium shriek loop",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=7800,
        fundamental_hz=390.7,
        synth_fn=synth_eng_flat6_7800,
    ),
    # V12 NA (Daytona SP3 / Corsa) — 4 zones
    StemSpec(
        stem_id="eng_v12_1000",
        filename="eng_v12_1000.wav",
        category="engine",
        description="1000 RPM V12 NA silky idle loop (Daytona SP3 / Corsa)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=1000,
        fundamental_hz=100.0,
        synth_fn=synth_eng_v12_1000,
    ),
    StemSpec(
        stem_id="eng_v12_low",
        filename="eng_v12_low.wav",
        category="engine",
        description="2500 RPM V12 NA deep exotic pull loop (Daytona SP3 / Corsa)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=2500,
        fundamental_hz=250.7,
        synth_fn=synth_eng_v12_low,
    ),
    StemSpec(
        stem_id="eng_v12_5000",
        filename="eng_v12_5000.wav",
        category="engine",
        description="5000 RPM V12 NA howling mid-high loop (Daytona SP3 / Corsa)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=5000,
        fundamental_hz=500.0,
        synth_fn=synth_eng_v12_5000,
    ),
    StemSpec(
        stem_id="eng_v12_8000",
        filename="eng_v12_8000.wav",
        category="engine",
        description="8000 RPM V12 NA F1-grade soprano scream loop (Daytona SP3 / Corsa)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=8000,
        fundamental_hz=800.0,
        synth_fn=synth_eng_v12_8000,
    ),
    # V10 Screamer (Huracán / Fulmine) — 4 zones
    StemSpec(
        stem_id="eng_v10_1000",
        filename="eng_v10_1000.wav",
        category="engine",
        description="1000 RPM V10 odd-fire 54°/90° idle loop (Huracán / Fulmine)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=1000,
        fundamental_hz=84.0,
        synth_fn=synth_eng_v10_1000,
    ),
    StemSpec(
        stem_id="eng_v10_low",
        filename="eng_v10_low.wav",
        category="engine",
        description="2400 RPM V10 throaty odd-fire rasp loop (Huracán / Fulmine)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=2400,
        fundamental_hz=200.0,
        synth_fn=synth_eng_v10_low,
    ),
    StemSpec(
        stem_id="eng_v10_5500",
        filename="eng_v10_5500.wav",
        category="engine",
        description="5200 RPM V10 screaming odd-fire wail loop (Huracán / Fulmine)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=5200,
        fundamental_hz=433.3,
        synth_fn=synth_eng_v10_5500,
    ),
    StemSpec(
        stem_id="eng_v10_7800",
        filename="eng_v10_7800.wav",
        category="engine",
        description="7800 RPM V10 redline F1 shriek loop (Huracán / Fulmine)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=7800,
        fundamental_hz=650.7,
        synth_fn=synth_eng_v10_7800,
    ),
    # 4-Rotor Bridge-Port (RX-7 FD / 787B) — 4 zones
    StemSpec(
        stem_id="eng_rotary4_1100",
        filename="eng_rotary4_1100.wav",
        category="engine",
        description="1100 RPM 4-Rotor unmistakable 9.3 Hz bridge-port BRAP-BRAP-BRAP idle loop (RX-7 FD)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=1100,
        fundamental_hz=74.7,
        synth_fn=synth_eng_rotary4_1100,
    ),
    StemSpec(
        stem_id="eng_rotary4_low",
        filename="eng_rotary4_low.wav",
        category="engine",
        description="2600 RPM 4-Rotor snappy rotary pull loop (RX-7 FD)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=2600,
        fundamental_hz=173.3,
        synth_fn=synth_eng_rotary4_low,
    ),
    StemSpec(
        stem_id="eng_rotary4_6000",
        filename="eng_rotary4_6000.wav",
        category="engine",
        description="5500 RPM 4-Rotor buzzing peripheral-port mid-high loop (787B)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=5500,
        fundamental_hz=366.7,
        synth_fn=synth_eng_rotary4_6000,
    ),
    StemSpec(
        stem_id="eng_rotary4_8500",
        filename="eng_rotary4_8500.wav",
        category="engine",
        description="8500 RPM 4-Rotor 787B chainsaw redline scream loop",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=8500,
        fundamental_hz=566.7,
        synth_fn=synth_eng_rotary4_8500,
    ),
    # Forged TT Inline-6 / V6 (Skyline R34 / NSX / Integrale) — 4 zones
    StemSpec(
        stem_id="eng_tt_i6_1000",
        filename="eng_tt_i6_1000.wav",
        category="engine",
        description="1000 RPM Forged TT Inline-6 deep straight-six idle loop (Skyline R34 / 2JZ)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=1000,
        fundamental_hz=50.7,
        synth_fn=synth_eng_tt_i6_1000,
    ),
    StemSpec(
        stem_id="eng_tt_i6_low",
        filename="eng_tt_i6_low.wav",
        category="engine",
        description="2400 RPM Forged TT Inline-6 creamy baritone RB26/2JZ pull loop",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=2400,
        fundamental_hz=120.0,
        synth_fn=synth_eng_tt_i6_low,
    ),
    StemSpec(
        stem_id="eng_tt_i6_4000",
        filename="eng_tt_i6_4000.wav",
        category="engine",
        description="4500 RPM Forged TT Inline-6 full-boost roar loop (Skyline R34 / 2JZ)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=4500,
        fundamental_hz=225.3,
        synth_fn=synth_eng_tt_i6_4000,
    ),
    StemSpec(
        stem_id="eng_tt_i6_7000",
        filename="eng_tt_i6_7000.wav",
        category="engine",
        description="7000 RPM Forged TT Inline-6 singing straight-six redline loop",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=7000,
        fundamental_hz=350.7,
        synth_fn=synth_eng_tt_i6_7000,
    ),
    # Cross-Plane V8 (Vela GT / Muscle / Harrier) — 4 zones
    StemSpec(
        stem_id="eng_v8_cross_900",
        filename="eng_v8_cross_900.wav",
        category="engine",
        description="900 RPM Cross-Plane V8 cammed unequal-bank burble loop (Vela GT / Muscle)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=900,
        fundamental_hz=58.7,
        synth_fn=synth_eng_v8_cross_900,
    ),
    StemSpec(
        stem_id="eng_v8_cross_low",
        filename="eng_v8_cross_low.wav",
        category="engine",
        description="2100 RPM Cross-Plane V8 thunderous low-end grunt loop (Vela GT / Muscle)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=2100,
        fundamental_hz=138.7,
        synth_fn=synth_eng_v8_cross_low,
    ),
    StemSpec(
        stem_id="eng_v8_cross_4200",
        filename="eng_v8_cross_4200.wav",
        category="engine",
        description="4200 RPM Cross-Plane V8 roaring pull loop (Vela GT / Muscle)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=4200,
        fundamental_hz=277.3,
        synth_fn=synth_eng_v8_cross_4200,
    ),
    StemSpec(
        stem_id="eng_v8_cross_6800",
        filename="eng_v8_cross_6800.wav",
        category="engine",
        description="6800 RPM Cross-Plane V8 roaring NASCAR/GT3 top-end loop",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=6800,
        fundamental_hz=453.3,
        synth_fn=synth_eng_v8_cross_6800,
    ),
    # Flat-Plane V8 (Fiamma / Tornado GT3) — 4 zones
    StemSpec(
        stem_id="eng_v8_flat_1100",
        filename="eng_v8_flat_1100.wav",
        category="engine",
        description="1100 RPM Flat-Plane V8 crisp Italian idle loop (Fiamma / Tornado GT3)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=1100,
        fundamental_hz=73.3,
        synth_fn=synth_eng_v8_flat_1100,
    ),
    StemSpec(
        stem_id="eng_v8_flat_low",
        filename="eng_v8_flat_low.wav",
        category="engine",
        description="2600 RPM Flat-Plane V8 sharp pull loop (Fiamma / Tornado GT3)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=2600,
        fundamental_hz=173.3,
        synth_fn=synth_eng_v8_flat_low,
    ),
    StemSpec(
        stem_id="eng_v8_flat_5500",
        filename="eng_v8_flat_5500.wav",
        category="engine",
        description="5200 RPM Flat-Plane V8 snarling Ferrari-style wail loop (Fiamma / GT3)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=5200,
        fundamental_hz=346.7,
        synth_fn=synth_eng_v8_flat_5500,
    ),
    StemSpec(
        stem_id="eng_v8_flat_8000",
        filename="eng_v8_flat_8000.wav",
        category="engine",
        description="8000 RPM Flat-Plane V8 blistering 8500-RPM scream loop (Fiamma / GT3)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=8000,
        fundamental_hz=533.3,
        synth_fn=synth_eng_v8_flat_8000,
    ),
    # Supercharged V8 (Hellhound) — 2 high-boost zones
    StemSpec(
        stem_id="eng_sc_v8_whine",
        filename="eng_sc_v8_whine.wav",
        category="engine",
        description="4200 RPM Supercharged Cross-Plane V8 + prominent Roots blower scream loop",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=4200,
        fundamental_hz=277.3,
        synth_fn=synth_eng_sc_v8_whine,
    ),
    StemSpec(
        stem_id="eng_sc_v8_6800",
        filename="eng_sc_v8_6800.wav",
        category="engine",
        description="6800 RPM Supercharged Cross-Plane V8 redline + jet-screaming blower whine loop",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=6800,
        fundamental_hz=453.3,
        synth_fn=synth_eng_sc_v8_6800,
    ),
    # Visceral FX Stems (7 stems)
    StemSpec(
        stem_id="turbo_spool_loop",
        filename="turbo_spool_loop.wav",
        category="drivetrain_induction",
        description="Garrett/BorgWarner turbocharger compressor wheel whistle (3400/6800 Hz) + pressurized charge-pipe rush loop",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=None,
        fundamental_hz=3400.0,
        synth_fn=synth_turbo_spool_loop,
    ),
    StemSpec(
        stem_id="turbo_flutter_bov",
        filename="turbo_flutter_bov.wav",
        category="drivetrain_induction",
        description="One-shot loud 6-pulse compressor-surge flutter (stu-tu-tu-tu-tu-tu) + resonant aluminum intake pipe ring",
        loop=False,
        duration_s=1.1,
        reference_rpm=None,
        fundamental_hz=1870.0,
        synth_fn=synth_turbo_flutter_bov,
    ),
    StemSpec(
        stem_id="exhaust_backfire_pop",
        filename="exhaust_backfire_pop.wav",
        category="drivetrain_induction",
        description="One-shot punchy shotgun exhaust bang + sub-bass shockwave + rapid double-crackle tail",
        loop=False,
        duration_s=0.55,
        reference_rpm=None,
        fundamental_hz=112.0,
        synth_fn=synth_exhaust_backfire_pop,
    ),
    StemSpec(
        stem_id="gear_whine_straightcut",
        filename="gear_whine_straightcut.wav",
        category="drivetrain_induction",
        description="GT3 sequential straight-cut transmission tooth-mesh whine loop (reference 1200 Hz mesh)",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=None,
        fundamental_hz=1200.0,
        synth_fn=synth_gear_whine_straightcut,
    ),
    StemSpec(
        stem_id="tyre_scrub_dry",
        filename="tyre_scrub_dry.wav",
        category="tyre_surface",
        description="Multi-harmonic sticky semi-slick dry rubber squeal/howl + 225 Hz tyre cavity loop",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=None,
        fundamental_hz=880.0,
        synth_fn=synth_tyre_scrub_dry,
    ),
    StemSpec(
        stem_id="tyre_spray_wet",
        filename="tyre_spray_wet.wav",
        category="tyre_surface",
        description="Wet asphalt hydroplane spray hiss + wheel-arch water splashes loop",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=None,
        fundamental_hz=3600.0,
        synth_fn=synth_tyre_spray_wet,
    ),
    StemSpec(
        stem_id="kerb_rumble_strip",
        filename="kerb_rumble_strip.wav",
        category="tyre_surface",
        description="Heavy hollow 32 Hz kerb block thumps + 225 Hz tyre air-cavity boom loop",
        loop=True,
        duration_s=LOOP_DURATION_S,
        reference_rpm=None,
        fundamental_hz=32.0,
        synth_fn=synth_kerb_rumble_strip,
    ),
]


# ---- 24-bit PCM WAV & Vorbis OGG I/O -------------------------------------------------------------


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


def encode_vorbis_ogg(wav_path: Path, ogg_path: Path, quality: int = 5) -> int:
    """Transcode a 48 kHz WAV stem to compact WebGPU Vorbis .ogg via ffmpeg libvorbis."""
    ffmpeg_bin = shutil.which("ffmpeg")
    if ffmpeg_bin is None:
        raise RuntimeError("ffmpeg not found on PATH; required for WebGPU Vorbis .ogg export")
    ogg_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg_bin,
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(wav_path),
        "-c:a",
        "libvorbis",
        "-q:a",
        str(quality),
        str(ogg_path),
    ]
    subprocess.run(cmd, check=True)
    return int(ogg_path.stat().st_size)


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


def _cleanup_stale_files(directory: Path, valid_names: set[str], suffix: str) -> list[str]:
    """Remove stale files with given suffix in directory that are no longer in STEM_SPECS."""
    removed: list[str] = []
    if not directory.is_dir():
        return removed
    for p in sorted(directory.iterdir()):
        if p.is_file() and p.suffix.lower() == suffix and p.name not in valid_names:
            p.unlink()
            removed.append(p.name)
    return removed


def generate_all(
    audio_dir: Path,
    manifest_path: Path,
    web_ogg_dir: Path | None,
) -> None:
    audio_dir.mkdir(parents=True, exist_ok=True)
    if web_ogg_dir is not None:
        web_ogg_dir.mkdir(parents=True, exist_ok=True)

    # Clean out any stale WAV / OGG files not in STEM_SPECS
    valid_wavs = {s.filename for s in STEM_SPECS}
    removed_wavs = _cleanup_stale_files(audio_dir, valid_wavs, ".wav")
    if removed_wavs:
        print(f"Removed {len(removed_wavs)} stale WAV files: {', '.join(removed_wavs)}")

    if web_ogg_dir is not None:
        valid_oggs = {f"{s.stem_id}.ogg" for s in STEM_SPECS}
        removed_oggs = _cleanup_stale_files(web_ogg_dir, valid_oggs, ".ogg")
        if removed_oggs:
            print(f"Removed {len(removed_oggs)} stale OGG files: {', '.join(removed_oggs)}")

    manifest_stems: list[dict[str, object]] = []
    total_ogg_bytes = 0

    for idx, spec in enumerate(STEM_SPECS):
        # Deterministic per-stem seed so re-runs are bit-reproducible
        rng = np.random.default_rng(20261122 + idx * 10007)
        samples = spec.synth_fn(rng)
        wav_path = audio_dir / spec.filename
        write_wav_24bit_mono(wav_path, samples, SAMPLE_RATE)

        ogg_bytes: int | None = None
        ogg_rel: str | None = None
        if web_ogg_dir is not None:
            ogg_path = web_ogg_dir / f"{spec.stem_id}.ogg"
            ogg_bytes = encode_vorbis_ogg(wav_path, ogg_path, quality=5)
            total_ogg_bytes += ogg_bytes
            ogg_rel = f"web/public/assets/audio/{spec.stem_id}.ogg"

        _, decoded = read_wav_24bit_mono(wav_path)
        stats = measure_stem(decoded)
        entry: dict[str, object] = {
            "id": spec.stem_id,
            "filename": spec.filename,
            "relative_wav_path": f"ue5/Import/Audio/{spec.filename}",
            "relative_ogg_path": ogg_rel,
            "ogg_bytes": ogg_bytes,
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
        manifest_stems.append(entry)
        ogg_str = f", ogg={ogg_bytes / 1024.0:5.1f}KB" if ogg_bytes is not None else ""
        print(
            f"Wrote {wav_path.name:28s} "
            f"({decoded.shape[0] / SAMPLE_RATE:4.2f}s, f0={spec.fundamental_hz:6.1f}Hz, "
            f"rms={stats['rms_dbfs']:6.2f}dBFS, peak={stats['peak_linear']:.3f}, "
            f"|end-start|={stats['boundary_delta']:.5f}{ogg_str})"
        )

    manifest = {
        "schema_version": 3,
        "generator": "tools/ue5/generate_audio_stems.py",
        "license": STEM_LICENSE,
        "provenance": PROVENANCE,
        "sample_rate_hz": SAMPLE_RATE,
        "bit_depth": BIT_DEPTH,
        "channels": CHANNELS,
        "output_dir": "ue5/Import/Audio",
        "web_ogg_dir": "web/public/assets/audio" if web_ogg_dir is not None else None,
        "web_ogg_total_bytes": total_ogg_bytes if web_ogg_dir is not None else None,
        "stem_count": len(manifest_stems),
        "stems": manifest_stems,
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    if web_ogg_dir is not None:
        print(
            f"Wrote {len(manifest_stems)} WebGPU Vorbis .ogg files to {web_ogg_dir} "
            f"(total {total_ogg_bytes / 1024.0:.1f} KB / {total_ogg_bytes / (1024.0 * 1024.0):.3f} MB)"
        )
    print(f"Wrote manifest: {manifest_path}")


def verify_all(
    audio_dir: Path,
    manifest_path: Path,
    web_ogg_dir: Path | None,
) -> None:
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

    if web_ogg_dir is not None and web_ogg_dir.is_dir():
        expected_oggs = {f"{s.stem_id}.ogg" for s in STEM_SPECS}
        stale_oggs = [p.name for p in web_ogg_dir.iterdir() if p.is_file() and p.suffix.lower() == ".ogg" and p.name not in expected_oggs]
        if stale_oggs:
            errors.append(f"Stale OGG files present in {web_ogg_dir}: {', '.join(sorted(stale_oggs))}")

    total_ogg_bytes = 0
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
        if not np.all(np.isfinite(samples)):
            errors.append(f"{spec.filename}: contains NaN or Inf")

        if web_ogg_dir is not None:
            ogg_path = web_ogg_dir / f"{spec.stem_id}.ogg"
            if not ogg_path.is_file():
                errors.append(f"Missing WebGPU OGG stem: {ogg_path}")
            else:
                sz = int(ogg_path.stat().st_size)
                if sz < 2048:
                    errors.append(f"{ogg_path.name}: suspiciously tiny OGG ({sz} bytes)")
                if ogg_path.read_bytes()[:4] != b"OggS":
                    errors.append(f"{ogg_path.name}: missing OggS magic header")
                total_ogg_bytes += sz

    if errors:
        print("FAILED MetaSound audio stem verification:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        sys.exit(1)

    ogg_note = (
        f"; {len(STEM_SPECS)} WebGPU .ogg files ({total_ogg_bytes / 1024.0:.1f} KB / "
        f"{total_ogg_bytes / (1024.0 * 1024.0):.3f} MB)"
        if web_ogg_dir is not None
        else ""
    )
    print(
        f"PASS MetaSound audio stem verification "
        f"({len(STEM_SPECS)} stems, 48 kHz / 24-bit PCM WAV, RMS in [-24, -6] dBFS, "
        f"peak <= 0.99, |end - start| < 0.02{ogg_note})"
    )


def main() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(
        description="Generate 48 kHz / 24-bit WAV (UE 5.8) and Vorbis OGG (WebGPU) audio stems."
    )
    parser.add_argument(
        "--audio-dir",
        type=Path,
        default=repo_root / "ue5" / "Import" / "Audio",
        help="Output WAV directory (default: ue5/Import/Audio)",
    )
    parser.add_argument(
        "--web-ogg-dir",
        type=Path,
        default=repo_root / "web" / "public" / "assets" / "audio",
        help="Output WebGPU Vorbis .ogg directory (default: web/public/assets/audio)",
    )
    parser.add_argument(
        "--no-ogg",
        action="store_true",
        help="Skip WebGPU Vorbis .ogg export and verification",
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
        help="Run automated DSP/header/loop/OGG verification after generation",
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Verify existing WAV/OGG stems and manifest without regenerating",
    )
    args = parser.parse_args()
    web_ogg_dir = None if args.no_ogg else args.web_ogg_dir

    if not args.verify_only:
        generate_all(args.audio_dir, args.manifest, web_ogg_dir)

    if args.verify or args.verify_only:
        verify_all(args.audio_dir, args.manifest, web_ogg_dir)


if __name__ == "__main__":
    main()
