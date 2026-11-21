#!/usr/bin/env python3
"""
Apache-2.0 — Procedural 48 kHz / 24-bit PCM WAV + WebGPU Vorbis OGG audio stem generator
for OpenGrid (UE 5.8 + WebGPU).

Synthesizes 21 visceral, dyno-grade automotive audio stems using 100% original procedural DSP
(physical cylinder-by-cylinder blowdown pulse-trains, dual-bank exhaust header waveguides,
Helmholtz muffler/plenum resonances, asymmetric exhaust shock saturation; zero third-party
samples; output licence CC-BY-NC-4.0):

  Engine loops (15 stems, 2.0 s exact integer-cycle seamless loops):
    - eng_flat6_low.wav          (1800 RPM Flat-6 NA boxer growl, 992 GT3 RS)
    - eng_flat6_4000.wav         (4000 RPM Flat-6 NA metallic titanium shriek)
    - eng_v12_low.wav            (2000 RPM V12 NA silky exotic idle/burble, Daytona SP3)
    - eng_v12_5000.wav           (5000 RPM V12 NA F1 soprano scream)
    - eng_v10_low.wav            (2000 RPM V10 odd-fire 54°/90° growl, Huracán / Fulmine)
    - eng_v10_5500.wav           (5500 RPM V10 feral howl)
    - eng_rotary4_low.wav        (1600 RPM 4-Rotor bridge-port chunky BRAP-BRAP idle, RX-7 FD)
    - eng_rotary4_6000.wav       (6000 RPM 4-Rotor peripheral-port 787B razor shriek)
    - eng_tt_i6_low.wav          (1800 RPM Forged Twin-Turbo I6 deep baritone rumble)
    - eng_tt_i6_4000.wav         (4000 RPM Forged Twin-Turbo I6 + dual-impeller whistle)
    - eng_v8_cross_low.wav       (1500 RPM Cross-Plane V8 heavy unequal-bank lope/burble)
    - eng_v8_cross_4200.wav      (4200 RPM Cross-Plane V8 throaty roar)
    - eng_v8_flat_low.wav        (2000 RPM Flat-Plane V8 crisp Italian growl)
    - eng_v8_flat_5500.wav       (5500 RPM Flat-Plane V8 high-rev snarl)
    - eng_sc_v8_whine.wav        (4000 RPM Supercharged Cross-Plane V8 + screaming Roots blower)

  Drivetrain, induction & exhaust FX stems (3 stems):
    - gear_whine_straightcut.wav (2.0 s loop, straight-cut sequential dog-box tooth-mesh whine)
    - turbo_flutter_bov.wav      (1.1 s one-shot, crisp 5-pulse compressor-surge stu-tu-tu-tu)
    - exhaust_backfire_pop.wav   (0.55 s one-shot, shotgun overrun crack + sub thump + Ti ring)

  Tyre & road surface loops (3 stems, 2.0 s seamless loops):
    - tyre_scrub_dry.wav         (dry asphalt multi-band rubber stick-slip screech/howl)
    - tyre_spray_wet.wav         (wet asphalt standing-water hydroplane spray + arch splash)
    - kerb_rumble_strip.wav      (32.0 Hz hollow suspension + tyre thudding kerb impacts)

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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

SAMPLE_RATE = 48000
BIT_DEPTH = 24
CHANNELS = 1
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


@dataclass(frozen=True)
class EnginePhysConfig:
    """Physical combustion pulse-train + dual-bank exhaust waveguide parameters."""

    rpm: float
    cycle_deg: float  # 720.0 for 4-stroke, 360.0 for Wankel rotary
    cylinders: tuple[CylinderEvent, ...]
    # Blowdown pressure impulse: (t/tau)^exp * exp(-t/tau) - rarefaction * tail + valve-crack shock
    blowdown_tau_ms: float
    blowdown_exp: float = 1.3
    shock_mix: float = 0.55  # supersonic valve-crack shock front for midrange/upper-mid harmonic bite
    rarefaction_depth: float = 0.34
    rarefaction_tau_mult: float = 2.45
    rarefaction_delay_mult: float = 1.15
    # Physical tailpipe acoustic radiation tilt (+6 dB/oct volume-velocity -> far-field pressure)
    rad_corner_hz: float = 1800.0
    rad_tilt_exp: float = 1.05
    # Cycle-to-cycle stochastic variation (CCV)
    energy_jitter_frac: float = 0.11  # 8-14% realistic combustion energy jitter
    time_jitter_ms: float = 0.24  # 0.15-0.45 ms realistic firing-time jitter
    tau_jitter_frac: float = 0.07
    # Optional periodic multi-cycle firing amplitude modulation (e.g. bridge-port BRAP)
    supercycle_pattern: tuple[float, ...] | None = None
    # Dual-bank exhaust header waveguide delays & open-end comb reflections
    bank0_delay_ms: float = 1.6
    bank1_delay_ms: float = 2.3
    pipe0_tau_ms: float = 3.2
    pipe1_tau_ms: float = 3.5
    pipe_fwd_gain: float = 0.34
    pipe_fb_gain: float = 0.36
    pipe_damp_hz: float = 4200.0
    xpipe_mix: float = 0.22
    xpipe_delay_ms: float = 0.9
    # Exhaust turbulence & crackle locked to blowdown gas velocity
    rasp_gain: float = 0.28
    rasp_lo_hz: float = 360.0
    rasp_hi_hz: float = 4200.0
    crackle_gain: float = 0.18
    crackle_lo_hz: float = 2400.0
    crackle_hi_hz: float = 10500.0
    # Muffler Helmholtz & tailpipe body resonances
    band_lo_hz: float = 38.0
    band_hi_hz: float = 10500.0
    exhaust_formants: tuple[tuple[float, float, float], ...] = ()
    # Intake plenum / ITB roar
    intake_gain: float = 0.22
    intake_tau_mult: float = 1.85
    intake_angle_offset_deg: float = -210.0
    intake_formants: tuple[tuple[float, float, float], ...] = (
        (240.0, 90.0, 1.4),
        (820.0, 260.0, 1.3),
    )
    intake_rush_gain: float = 0.09
    intake_rush_band: tuple[float, float] = (950.0, 6200.0)
    # Mechanical valvetrain / timing texture
    mech_gain: float = 0.04
    mech_band: tuple[float, float] = (2800.0, 9500.0)
    # Asymmetric tube / titanium shockwave saturation
    sat_drive: float = 1.70
    sat_asym: float = 0.12
    # Post-saturation sheen & harmonic reinforcement
    post_formants: tuple[tuple[float, float, float], ...] = ()
    sub_bass_boost_hz: float = 0.0
    sub_bass_gain: float = 0.0
    # Target RMS
    target_rms_dbfs: float = -13.5


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
    """Sum of Lorentzian Helmholtz / pipe formant peaks: (center_hz, bandwidth_hz, gain)."""
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
      propagation delay + damped open-end reflection comb + resonant feedback pipe modes.
    """
    two_pi = 2.0 * math.pi
    d_sec = delay_ms * 1e-3
    tau_sec = pipe_tau_ms * 1e-3
    wall_damp = 1.0 / np.sqrt(1.0 + (freqs / damp_hz) ** 2)
    z_delay = np.exp(-1j * two_pi * freqs * d_sec)
    z_pipe = np.exp(-1j * two_pi * freqs * tau_sec)
    # Negative reflection at open tailpipe creates realistic odd/even hollowness + metallic bark
    num = 1.0 - fwd_gain * wall_damp * z_pipe
    den = 1.0 - fb_gain * wall_damp * (z_pipe ** 2)
    return z_delay * (num / den)


def _tailpipe_radiation_curve(
    freqs: np.ndarray,
    corner_hz: float = 1800.0,
    tilt_exp: float = 1.05,
) -> np.ndarray:
    """
    Physical open-tailpipe acoustic radiation impedance: far-field pressure p_rad ~ dU/dt
    gives a +6 dB/octave upward tilt from bass up to pipe cutoff f_c = c/(pi*d) (~1.5-3.0 kHz),
    converting raw volume-velocity blowdown pulses into realistic dyno-microphone pressure!
    """
    f_safe = np.maximum(freqs, 1.0)
    return (f_safe / np.sqrt(f_safe * f_safe + corner_hz * corner_hz)) ** tilt_exp


def _asymmetric_saturate(
    x: np.ndarray,
    drive: float = 1.7,
    asym: float = 0.12,
    dry_mix: float = 0.22,
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
    wet = wet + 0.16 * np.tanh(drive * 1.55 * xn)
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


def _finalize_loop(x: np.ndarray, target_rms_dbfs: float = -13.5) -> np.ndarray:
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
    target_rms_dbfs: float = -14.0,
    fade_in_ms: float = 3.0,
    fade_out_ms: float = 45.0,
    sr: int = SAMPLE_RATE,
) -> np.ndarray:
    """High-pass DC, fade cleanly to zero at both ends, normalize RMS, soft-limit."""
    y = _circular_fft_shape(x, lambda f: _bandpass_curve(f, 22.0, 19000.0, order=2.0), sr)
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
      p(t) = (t/tau)^exp * exp(-t/tau) + shock_mix * (t/tau_s)^1.15 * exp(-t/tau_s)
             - rarefaction_depth * ((t-d)/tau_r)^1.5 * exp(-(t-d)/tau_r)
    along with its unipolar gas-velocity turbulence envelope.
    """
    n = buf_wave.shape[0]
    s0 = int(math.floor(event_sample))
    frac = event_sample - s0

    # Window covers full blowdown + rarefaction decay (< 1e-4 tail)
    win = min(n, max(64, int(math.ceil((rarefaction_delay_s + 9.5 * rarefaction_tau_s) * sr)) + 4))
    k = np.arange(win, dtype=np.int64)
    dt = (k.astype(np.float64) - frac) / sr
    dt_pos = np.maximum(dt, 0.0)

    # Positive bulk cylinder blowdown wave normalized to unit peak
    u = dt_pos / tau_s
    norm_pos = (math.e / exp_rise) ** exp_rise
    p_pos = (u ** exp_rise) * np.exp(-u) * norm_pos

    # Supersonic choked-flow valve-crack shock front (rich upper-mid exhaust bark)
    if shock_mix > 0.0:
        tau_shock = max(0.00014, tau_s * 0.22)
        us = dt_pos / tau_shock
        norm_s = (math.e / 1.15) ** 1.15
        p_shock = shock_mix * (us ** 1.15) * np.exp(-us) * norm_s
    else:
        p_shock = 0.0

    # Negative scavenging rarefaction trough normalized to unit peak
    dt_r = np.maximum(dt - rarefaction_delay_s, 0.0)
    v = dt_r / rarefaction_tau_s
    norm_neg = (math.e / 1.5) ** 1.5
    p_neg = rarefaction_depth * (v ** 1.5) * np.exp(-v) * norm_neg

    # Gas-velocity turbulence burst peaks slightly after shock front
    u_t = dt_pos / (tau_s * 1.35)
    turb = (u_t ** 1.1) * np.exp(-u_t) * ((math.e / 1.1) ** 1.1)

    dest = (s0 + k) % n
    buf_wave[dest] += amp * (p_pos + p_shock - p_neg)
    buf_turb[dest] += abs(amp) * turb


def _synth_physical_engine(
    cfg: EnginePhysConfig,
    rng: np.random.Generator,
    duration_s: float = 2.0,
    extra_layer_fn: Callable[[np.ndarray, float, np.random.Generator], np.ndarray] | None = None,
) -> np.ndarray:
    """
    Synthesize a mathematically periodic 2.0 s physical combustion + exhaust waveguide engine loop.

    1. Snaps thermodynamic cycle count to an exact integer over duration_s (or divisible by
       supercycle period when bridge-port overlap lope is active).
    2. Places asymmetric blowdown impulses per cylinder at exact firing-order crank angles with
       stochastic cycle-to-cycle combustion energy jitter (8-14%), firing-time jitter (0.15-0.45 ms),
       and subtle pulse-width jitter.
    3. Routes Bank 0 and Bank 1 through dual-pipe exhaust header waveguide comb delays + X/H-pipe
       collector merge.
    4. Modulates broadband exhaust-gas rasp & high-frequency crackle locked to each blowdown burst.
    5. Synthesizes intake plenum / ITB induction pulses + airbox Helmholtz resonance.
    6. Applies asymmetric warm tube / titanium saturation and muffler body formants.
    """
    n = int(round(SAMPLE_RATE * duration_s))
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE

    # Exact integer number of thermodynamic firing cycles over duration_s
    cycles_per_sec_nom = (cfg.rpm / 60.0) * (360.0 / cfg.cycle_deg)
    n_cycles = max(1, int(round(cycles_per_sec_nom * duration_s)))

    # If a multi-cycle firing pattern is given (e.g. 3-rev bridge-port BRAP), align n_cycles to it
    n_cyl = len(cfg.cylinders)
    if cfg.supercycle_pattern is not None:
        pat_len = len(cfg.supercycle_pattern)
        cycles_per_pat = max(1, pat_len // max(1, n_cyl))
        n_cycles = max(cycles_per_pat, int(round(n_cycles / cycles_per_pat)) * cycles_per_pat)

    cycle_dur_s = duration_s / n_cycles
    f_crank = (n_cycles / duration_s) * (cfg.cycle_deg / 360.0)

    bank0_raw = np.zeros(n, dtype=np.float64)
    bank1_raw = np.zeros(n, dtype=np.float64)
    turb0 = np.zeros(n, dtype=np.float64)
    turb1 = np.zeros(n, dtype=np.float64)
    intake_raw = np.zeros(n, dtype=np.float64)
    intake_env = np.zeros(n, dtype=np.float64)

    base_tau_s = max(0.00030, cfg.blowdown_tau_ms * 1e-3)
    intake_tau_s = base_tau_s * cfg.intake_tau_mult

    # Fixed subtle cylinder-to-cylinder mechanical manufacturing variance (makes each cyl unique)
    cyl_static_amp = 1.0 + rng.uniform(-0.045, 0.045, size=n_cyl)
    cyl_static_tau = 1.0 + rng.uniform(-0.04, 0.04, size=n_cyl)

    firing_idx = 0
    for c in range(n_cycles):
        cycle_t0 = c * cycle_dur_s
        for idx, cyl in enumerate(cfg.cylinders):
            pat_mult = 1.0
            if cfg.supercycle_pattern is not None:
                pat_mult = cfg.supercycle_pattern[firing_idx % len(cfg.supercycle_pattern)]
            firing_idx += 1

            # Stochastic cycle-to-cycle combustion energy jitter (clipped Gaussian)
            e_jit = float(np.clip(rng.normal(0.0, cfg.energy_jitter_frac), -0.32, 0.35))
            amp = cyl.amp_trim * cyl_static_amp[idx] * pat_mult * (1.0 + e_jit)

            # Stochastic cycle-to-cycle firing-time jitter (0.15-0.45 ms range)
            t_jit_ms = float(np.clip(rng.normal(0.0, cfg.time_jitter_ms * 0.65), -cfg.time_jitter_ms * 1.4, cfg.time_jitter_ms * 1.4))
            event_t = (
                cycle_t0
                + (cyl.angle_deg / cfg.cycle_deg) * cycle_dur_s
                + (cyl.runner_delay_ms + t_jit_ms) * 1e-3
            ) % duration_s

            # Pulse-width combustion burn-rate jitter
            tau_jit = float(np.clip(rng.normal(1.0, cfg.tau_jitter_frac), 0.80, 1.25))
            tau_i = max(0.00028, base_tau_s * cyl_static_tau[idx] * tau_jit)
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
                in_angle = (cyl.angle_deg + cfg.intake_angle_offset_deg) % cfg.cycle_deg
                in_t = (cycle_t0 + (in_angle / cfg.cycle_deg) * cycle_dur_s + t_jit_ms * 0.5e-3) % duration_s
                _scatter_blowdown_pulse(
                    intake_raw,
                    intake_env,
                    in_t * SAMPLE_RATE,
                    amp * 0.85,
                    intake_tau_s * tau_jit,
                    1.45,
                    0.20,
                    0.22,
                    intake_tau_s * 2.2,
                    intake_tau_s * 1.2,
                )

    # Dual-bank exhaust header waveguide delays + open-end collector comb filtering (circular FFT)
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
            * _bandpass_curve(f, 90.0, 4800.0, order=2.0),
        )
        merged = merged + cfg.xpipe_mix * x_scav

    # Apply physical open-tailpipe acoustic radiation impedance (volume velocity -> radiated pressure)
    merged = _circular_fft_shape(
        merged,
        lambda f: _tailpipe_radiation_curve(f, cfg.rad_corner_hz, cfg.rad_tilt_exp)
        * _bandpass_curve(f, cfg.band_lo_hz, cfg.band_hi_hz, order=1.8),
    )

    # Normalize pulse-locked turbulence envelopes
    turb_all = turb0 + turb1
    turb_peak = float(np.percentile(turb_all, 98)) + 1e-9
    turb_norm = np.clip(turb_all / turb_peak, 0.0, 2.2)

    # Broadband exhaust-gas turbulence rasp locked to cylinder blowdowns
    exhaust_rms = float(np.sqrt(np.mean(merged * merged))) + 1e-9
    if cfg.rasp_gain > 0.0:
        rasp_noise = _circular_fft_shape(
            rng.standard_normal(n),
            lambda f: _bandpass_curve(f, cfg.rasp_lo_hz, cfg.rasp_hi_hz, order=2.0)
            * _waveguide_pipe_tf(
                f,
                0.5 * (cfg.bank0_delay_ms + cfg.bank1_delay_ms),
                0.5 * (cfg.pipe0_tau_ms + cfg.pipe1_tau_ms),
                cfg.pipe_fwd_gain * 0.7,
                cfg.pipe_fb_gain * 0.6,
                cfg.pipe_damp_hz,
            ),
        )
        rasp_noise /= float(np.sqrt(np.mean(rasp_noise * rasp_noise))) + 1e-9
        rasp = rasp_noise * (0.20 + 0.80 * turb_norm) * (exhaust_rms * cfg.rasp_gain)
    else:
        rasp = np.zeros(n, dtype=np.float64)

    # High-velocity blowdown shock crackle / tearing-air texture
    if cfg.crackle_gain > 0.0:
        crackle_noise = _circular_fft_shape(
            rng.standard_normal(n),
            lambda f: _bandpass_curve(f, cfg.crackle_lo_hz, cfg.crackle_hi_hz, order=2.0),
        )
        crackle_noise /= float(np.sqrt(np.mean(crackle_noise * crackle_noise))) + 1e-9
        crackle = crackle_noise * (turb_norm ** 1.55) * (exhaust_rms * cfg.crackle_gain)
    else:
        crackle = np.zeros(n, dtype=np.float64)

    exhaust_pre = merged + rasp + crackle

    # Muffler Helmholtz cavities & tailpipe spectral contour
    exhaust_body = _circular_fft_shape(
        exhaust_pre,
        lambda f: _bandpass_curve(f, cfg.band_lo_hz, cfg.band_hi_hz, order=2.0)
        * _resonator_bank(f, cfg.exhaust_formants),
    )

    # Asymmetric warm tube / titanium exhaust-shock saturation
    exhaust_sat = _asymmetric_saturate(exhaust_body, drive=cfg.sat_drive, asym=cfg.sat_asym)

    # Post-saturation exhaust polish & optional chest sub-bass weight
    def _post_resp(f: np.ndarray) -> np.ndarray:
        h = _bandpass_curve(f, max(28.0, cfg.band_lo_hz * 0.8), min(14500.0, cfg.band_hi_hz * 1.25), order=2.0)
        if cfg.post_formants:
            h = h * _resonator_bank(f, cfg.post_formants)
        if cfg.sub_bass_boost_hz > 0.0 and cfg.sub_bass_gain > 0.0:
            h = h * (1.0 + cfg.sub_bass_gain / (1.0 + ((f - cfg.sub_bass_boost_hz) / (cfg.sub_bass_boost_hz * 0.45)) ** 2))
        return h

    exhaust_final = _circular_fft_shape(exhaust_sat, _post_resp)
    ex_rms = float(np.sqrt(np.mean(exhaust_final * exhaust_final))) + 1e-9

    # Intake plenum / ITB roar + pressurized induction rush (with airbox radiation tilt)
    if cfg.intake_gain > 0.0:
        intake_shaped = _circular_fft_shape(
            intake_raw,
            lambda f: _tailpipe_radiation_curve(f, 1200.0, 0.85)
            * _bandpass_curve(f, 80.0, 6400.0, order=2.0)
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
        intake_part = intake_part + rush * (0.35 + 0.65 * in_env_norm) * (ex_rms * cfg.intake_rush_gain)
    else:
        intake_part = np.zeros(n, dtype=np.float64)

    # Mechanical valvetrain / timing chain / injector presence
    if cfg.mech_gain > 0.0:
        mech = _circular_fft_shape(
            rng.standard_normal(n),
            lambda f: _bandpass_curve(f, cfg.mech_band[0], cfg.mech_band[1], order=2.0),
        )
        mech /= float(np.sqrt(np.mean(mech * mech))) + 1e-9
        mech_part = mech * (0.45 + 0.55 * turb_norm) * (ex_rms * cfg.mech_gain)
    else:
        mech_part = np.zeros(n, dtype=np.float64)

    total = exhaust_final + intake_part + mech_part

    # Optional forced-induction layer (turbo spool whistle / Roots supercharger whine)
    if extra_layer_fn is not None:
        extra = extra_layer_fn(t, f_crank, rng)
        total = total + extra * ex_rms

    # Subtle exact-integer-cycle dyno-load breathing (alive, never rhythmic)
    breath = (
        1.0
        + 0.028 * np.sin(2.0 * math.pi * 0.5 * t + 0.3)
        + 0.018 * np.sin(2.0 * math.pi * 1.5 * t + 1.9)
    )
    return _finalize_loop(total * breath, target_rms_dbfs=cfg.target_rms_dbfs)


# ---- Canonical Real-World Cylinder Layouts -------------------------------------------------------

# Porsche 992 GT3 RS Flat-6 (firing order 1-6-2-4-3-5, alternating L/R every 120°)
_CYL_FLAT6: tuple[CylinderEvent, ...] = (
    CylinderEvent(0.0, 0, 0.00, 1.02),
    CylinderEvent(120.0, 1, 0.14, 0.99),
    CylinderEvent(240.0, 0, 0.22, 1.00),
    CylinderEvent(360.0, 1, 0.08, 1.03),
    CylinderEvent(480.0, 0, 0.18, 0.98),
    CylinderEvent(600.0, 1, 0.26, 1.01),
)

# Ferrari Daytona SP3 65° V12 (firing order 1-12-5-8-3-10-6-7-2-11-4-9, alternating L/R every 60°)
_CYL_V12: tuple[CylinderEvent, ...] = tuple(
    CylinderEvent(
        angle_deg=i * 60.0,
        bank=i % 2,
        runner_delay_ms=0.06 * ((i * 5) % 4),
        amp_trim=0.97 + 0.06 * ((i % 3) / 2.0),
    )
    for i in range(12)
)

# Lamborghini Huracán / R8 90° Odd-Fire V10 (1-6-5-10-2-7-3-8-4-9, alternating 54° / 90° intervals!)
_CYL_V10_ODDFIRE: tuple[CylinderEvent, ...] = (
    CylinderEvent(0.0, 0, 0.00, 1.04),
    CylinderEvent(54.0, 1, 0.16, 0.98),
    CylinderEvent(144.0, 0, 0.12, 1.01),
    CylinderEvent(198.0, 1, 0.24, 1.03),
    CylinderEvent(288.0, 0, 0.08, 0.97),
    CylinderEvent(342.0, 1, 0.18, 1.02),
    CylinderEvent(432.0, 0, 0.22, 1.00),
    CylinderEvent(486.0, 1, 0.06, 0.99),
    CylinderEvent(576.0, 0, 0.14, 1.03),
    CylinderEvent(630.0, 1, 0.20, 0.98),
)

# Mazda 4-Rotor Wankel (0°, 90°, 180°, 270° eccentric shaft firing over 360°)
_CYL_ROTARY4: tuple[CylinderEvent, ...] = (
    CylinderEvent(0.0, 0, 0.00, 1.03),
    CylinderEvent(90.0, 1, 0.15, 0.98),
    CylinderEvent(180.0, 0, 0.10, 1.01),
    CylinderEvent(270.0, 1, 0.22, 0.99),
)

# RB26 / 2JZ Forged Inline-6 (1-5-3-6-2-4, 3+3 twin-scroll banks, even 120° firing)
_CYL_I6_TT: tuple[CylinderEvent, ...] = (
    CylinderEvent(0.0, 0, 0.00, 1.01),    # Cyl 1 (front 3)
    CylinderEvent(120.0, 1, 0.18, 1.00),  # Cyl 5 (rear 3)
    CylinderEvent(240.0, 0, 0.12, 0.99),  # Cyl 3 (front 3)
    CylinderEvent(360.0, 1, 0.24, 1.02),  # Cyl 6 (rear 3)
    CylinderEvent(480.0, 0, 0.08, 1.00),  # Cyl 2 (front 3)
    CylinderEvent(600.0, 1, 0.15, 0.98),  # Cyl 4 (rear 3)
)

# American Cross-Plane V8 (1-8-4-3-6-5-7-2 -> uneven 90°/180°/270°/180° per-bank firing!)
_CYL_V8_CROSS: tuple[CylinderEvent, ...] = (
    CylinderEvent(0.0, 0, 0.00, 1.05),    # Cyl 1 (L)
    CylinderEvent(90.0, 1, 0.25, 0.97),   # Cyl 8 (R)
    CylinderEvent(180.0, 1, 0.12, 1.06),  # Cyl 4 (R) - consecutive R bank!
    CylinderEvent(270.0, 0, 0.30, 0.98),  # Cyl 3 (L)
    CylinderEvent(360.0, 1, 0.08, 1.02),  # Cyl 6 (R)
    CylinderEvent(450.0, 0, 0.22, 1.01),  # Cyl 5 (L)
    CylinderEvent(540.0, 0, 0.15, 1.07),  # Cyl 7 (L) - consecutive L bank!
    CylinderEvent(630.0, 1, 0.28, 0.96),  # Cyl 2 (R)
)

# Italian Flat-Plane V8 (1-5-3-7-4-8-2-6, strictly alternating L/R every 90°)
_CYL_V8_FLAT: tuple[CylinderEvent, ...] = (
    CylinderEvent(0.0, 0, 0.00, 1.02),
    CylinderEvent(90.0, 1, 0.08, 1.00),
    CylinderEvent(180.0, 0, 0.12, 0.99),
    CylinderEvent(270.0, 1, 0.06, 1.02),
    CylinderEvent(360.0, 0, 0.14, 1.01),
    CylinderEvent(450.0, 1, 0.10, 0.98),
    CylinderEvent(540.0, 0, 0.05, 1.01),
    CylinderEvent(630.0, 1, 0.12, 0.99),
)


# ---- Engine Loop Synthesizers (15 Stems, 2.0 s Seamless Loops) -----------------------------------


def synth_eng_flat6_low(rng: np.random.Generator) -> np.ndarray:
    """1800 RPM Flat-6 NA (992 GT3 RS) hollow boxer growl & ITB induction burble."""
    cfg = EnginePhysConfig(
        rpm=1800.0,
        cycle_deg=720.0,
        cylinders=_CYL_FLAT6,
        blowdown_tau_ms=1.45,
        blowdown_exp=1.30,
        shock_mix=0.68,
        rarefaction_depth=0.38,
        rarefaction_tau_mult=2.55,
        rad_corner_hz=1500.0,
        rad_tilt_exp=1.15,
        energy_jitter_frac=0.115,
        time_jitter_ms=0.32,
        tau_jitter_frac=0.08,
        bank0_delay_ms=1.80,
        bank1_delay_ms=2.95,
        pipe0_tau_ms=5.60,
        pipe1_tau_ms=6.25,
        pipe_fwd_gain=0.38,
        pipe_fb_gain=0.36,
        pipe_damp_hz=4200.0,
        xpipe_mix=0.25,
        xpipe_delay_ms=1.20,
        rasp_gain=0.32,
        rasp_lo_hz=260.0,
        rasp_hi_hz=3800.0,
        crackle_gain=0.16,
        crackle_lo_hz=1800.0,
        crackle_hi_hz=8200.0,
        band_lo_hz=36.0,
        band_hi_hz=8600.0,
        exhaust_formants=((90.0, 32.0, 1.4), (185.0, 58.0, 1.5), (450.0, 140.0, 1.5), (1250.0, 320.0, 1.8)),
        intake_gain=0.28,
        intake_formants=((180.0, 65.0, 1.5), (640.0, 200.0, 1.5), (1450.0, 380.0, 1.2)),
        intake_rush_gain=0.09,
        mech_gain=0.045,
        sat_drive=1.75,
        sat_asym=0.13,
        post_formants=((1580.0, 380.0, 0.95),),
        sub_bass_boost_hz=90.0,
        sub_bass_gain=0.45,
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_flat6_4000(rng: np.random.Generator) -> np.ndarray:
    """4000 RPM Flat-6 NA (992 GT3 RS) metallic titanium howl & shrieking ITB roar."""
    cfg = EnginePhysConfig(
        rpm=4000.0,
        cycle_deg=720.0,
        cylinders=_CYL_FLAT6,
        blowdown_tau_ms=0.56,
        blowdown_exp=1.25,
        shock_mix=0.82,
        rarefaction_depth=0.32,
        rarefaction_tau_mult=2.30,
        rad_corner_hz=2600.0,
        rad_tilt_exp=1.30,
        energy_jitter_frac=0.095,
        time_jitter_ms=0.20,
        tau_jitter_frac=0.06,
        bank0_delay_ms=1.40,
        bank1_delay_ms=2.20,
        pipe0_tau_ms=2.35,
        pipe1_tau_ms=2.68,
        pipe_fwd_gain=0.40,
        pipe_fb_gain=0.46,
        pipe_damp_hz=6400.0,
        xpipe_mix=0.26,
        xpipe_delay_ms=0.80,
        rasp_gain=0.34,
        rasp_lo_hz=480.0,
        rasp_hi_hz=6200.0,
        crackle_gain=0.24,
        crackle_lo_hz=2600.0,
        crackle_hi_hz=12200.0,
        band_lo_hz=55.0,
        band_hi_hz=12500.0,
        exhaust_formants=(
            (201.0, 62.0, 1.2),
            (610.0, 155.0, 1.6),
            (1480.0, 310.0, 2.5),
            (2680.0, 490.0, 2.2),
            (4250.0, 750.0, 1.3),
        ),
        intake_gain=0.30,
        intake_formants=((410.0, 120.0, 1.4), (1180.0, 290.0, 1.7), (2350.0, 520.0, 1.4)),
        intake_rush_gain=0.11,
        intake_rush_band=(1100.0, 7800.0),
        mech_gain=0.05,
        sat_drive=1.95,
        sat_asym=0.14,
        post_formants=((1520.0, 340.0, 1.25), (2750.0, 520.0, 1.15)),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v12_low(rng: np.random.Generator) -> np.ndarray:
    """2000 RPM V12 NA (Daytona SP3 / Corsa) silky exotic burble with 6-per-bank undertone."""
    cfg = EnginePhysConfig(
        rpm=2000.0,
        cycle_deg=720.0,
        cylinders=_CYL_V12,
        blowdown_tau_ms=1.10,
        blowdown_exp=1.30,
        shock_mix=0.64,
        rarefaction_depth=0.34,
        rarefaction_tau_mult=2.45,
        rad_corner_hz=1850.0,
        rad_tilt_exp=1.18,
        energy_jitter_frac=0.10,
        time_jitter_ms=0.23,
        tau_jitter_frac=0.06,
        bank0_delay_ms=1.95,
        bank1_delay_ms=2.35,
        pipe0_tau_ms=4.10,
        pipe1_tau_ms=4.35,
        pipe_fwd_gain=0.34,
        pipe_fb_gain=0.40,
        pipe_damp_hz=5200.0,
        xpipe_mix=0.28,
        xpipe_delay_ms=0.65,
        rasp_gain=0.22,
        rasp_lo_hz=350.0,
        rasp_hi_hz=4400.0,
        crackle_gain=0.14,
        crackle_lo_hz=2200.0,
        crackle_hi_hz=9600.0,
        band_lo_hz=48.0,
        band_hi_hz=10200.0,
        exhaust_formants=(
            (99.0, 35.0, 1.2),
            (198.0, 62.0, 1.5),
            (594.0, 165.0, 1.7),
            (1260.0, 310.0, 1.9),
            (2300.0, 520.0, 1.4),
        ),
        intake_gain=0.25,
        intake_formants=((260.0, 85.0, 1.4), (780.0, 220.0, 1.6), (1650.0, 420.0, 1.3)),
        intake_rush_gain=0.08,
        mech_gain=0.04,
        sat_drive=1.55,
        sat_asym=0.10,
        post_formants=((1320.0, 340.0, 1.0),),
        sub_bass_boost_hz=99.0,
        sub_bass_gain=0.35,
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v12_5000(rng: np.random.Generator) -> np.ndarray:
    """5000 RPM V12 NA (Daytona SP3 / Corsa) piercing F1 soprano scream."""
    cfg = EnginePhysConfig(
        rpm=5000.0,
        cycle_deg=720.0,
        cylinders=_CYL_V12,
        blowdown_tau_ms=0.34,
        blowdown_exp=1.24,
        shock_mix=0.88,
        rarefaction_depth=0.28,
        rarefaction_tau_mult=2.15,
        rad_corner_hz=3100.0,
        rad_tilt_exp=1.35,
        energy_jitter_frac=0.085,
        time_jitter_ms=0.15,
        tau_jitter_frac=0.05,
        bank0_delay_ms=1.50,
        bank1_delay_ms=1.78,
        pipe0_tau_ms=1.82,
        pipe1_tau_ms=1.94,
        pipe_fwd_gain=0.42,
        pipe_fb_gain=0.50,
        pipe_damp_hz=7800.0,
        xpipe_mix=0.32,
        xpipe_delay_ms=0.50,
        rasp_gain=0.26,
        rasp_lo_hz=680.0,
        rasp_hi_hz=7800.0,
        crackle_gain=0.22,
        crackle_lo_hz=3200.0,
        crackle_hi_hz=13800.0,
        band_lo_hz=75.0,
        band_hi_hz=13800.0,
        exhaust_formants=(
            (249.0, 75.0, 1.2),
            (498.0, 120.0, 1.6),
            (1500.0, 320.0, 2.7),
            (2980.0, 580.0, 2.5),
            (4650.0, 820.0, 1.6),
        ),
        intake_gain=0.28,
        intake_formants=((520.0, 150.0, 1.4), (1560.0, 340.0, 1.9), (3100.0, 620.0, 1.5)),
        intake_rush_gain=0.10,
        intake_rush_band=(1600.0, 9800.0),
        mech_gain=0.045,
        sat_drive=1.85,
        sat_asym=0.12,
        post_formants=((1520.0, 320.0, 1.3), (3050.0, 560.0, 1.25)),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v10_low(rng: np.random.Generator) -> np.ndarray:
    """2000 RPM V10 Screamer (Huracán / Fulmine) odd-fire 54°/90° growl."""
    cfg = EnginePhysConfig(
        rpm=2000.0,
        cycle_deg=720.0,
        cylinders=_CYL_V10_ODDFIRE,
        blowdown_tau_ms=1.10,
        blowdown_exp=1.28,
        shock_mix=0.72,
        rarefaction_depth=0.36,
        rarefaction_tau_mult=2.45,
        rad_corner_hz=1900.0,
        rad_tilt_exp=1.20,
        energy_jitter_frac=0.115,
        time_jitter_ms=0.28,
        tau_jitter_frac=0.07,
        bank0_delay_ms=1.65,
        bank1_delay_ms=2.45,
        pipe0_tau_ms=4.45,
        pipe1_tau_ms=4.95,
        pipe_fwd_gain=0.38,
        pipe_fb_gain=0.42,
        pipe_damp_hz=4800.0,
        xpipe_mix=0.24,
        xpipe_delay_ms=0.95,
        rasp_gain=0.32,
        rasp_lo_hz=310.0,
        rasp_hi_hz=4600.0,
        crackle_gain=0.18,
        crackle_lo_hz=2100.0,
        crackle_hi_hz=9600.0,
        band_lo_hz=42.0,
        band_hi_hz=10000.0,
        exhaust_formants=(
            (82.5, 28.0, 1.3),
            (165.0, 52.0, 1.6),
            (415.0, 125.0, 1.7),
            (990.0, 260.0, 2.0),
            (1960.0, 440.0, 1.6),
        ),
        intake_gain=0.26,
        intake_formants=((240.0, 80.0, 1.5), (720.0, 210.0, 1.6)),
        intake_rush_gain=0.09,
        mech_gain=0.045,
        sat_drive=1.80,
        sat_asym=0.14,
        post_formants=((980.0, 260.0, 1.0), (1950.0, 420.0, 0.95)),
        sub_bass_boost_hz=82.5,
        sub_bass_gain=0.40,
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v10_5500(rng: np.random.Generator) -> np.ndarray:
    """5500 RPM V10 Screamer (Huracán / Fulmine) feral odd-fire 54°/90° howl."""
    cfg = EnginePhysConfig(
        rpm=5500.0,
        cycle_deg=720.0,
        cylinders=_CYL_V10_ODDFIRE,
        blowdown_tau_ms=0.34,
        blowdown_exp=1.24,
        shock_mix=0.86,
        rarefaction_depth=0.30,
        rarefaction_tau_mult=2.20,
        rad_corner_hz=2900.0,
        rad_tilt_exp=1.32,
        energy_jitter_frac=0.09,
        time_jitter_ms=0.16,
        tau_jitter_frac=0.06,
        bank0_delay_ms=1.35,
        bank1_delay_ms=1.95,
        pipe0_tau_ms=1.92,
        pipe1_tau_ms=2.16,
        pipe_fwd_gain=0.42,
        pipe_fb_gain=0.48,
        pipe_damp_hz=7200.0,
        xpipe_mix=0.28,
        xpipe_delay_ms=0.70,
        rasp_gain=0.34,
        rasp_lo_hz=580.0,
        rasp_hi_hz=7200.0,
        crackle_gain=0.24,
        crackle_lo_hz=2800.0,
        crackle_hi_hz=13500.0,
        band_lo_hz=68.0,
        band_hi_hz=13500.0,
        exhaust_formants=(
            (230.0, 68.0, 1.2),
            (460.0, 110.0, 1.6),
            (1150.0, 260.0, 2.2),
            (2320.0, 480.0, 2.6),
            (3850.0, 740.0, 1.9),
        ),
        intake_gain=0.28,
        intake_formants=((460.0, 130.0, 1.5), (1380.0, 320.0, 1.8), (2750.0, 560.0, 1.4)),
        intake_rush_gain=0.11,
        intake_rush_band=(1400.0, 9400.0),
        mech_gain=0.05,
        sat_drive=2.05,
        sat_asym=0.15,
        post_formants=((1180.0, 280.0, 1.1), (2380.0, 480.0, 1.25)),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_rotary4_low(rng: np.random.Generator) -> np.ndarray:
    """
    1600 RPM 4-Rotor Bridge-Port (RX-7 FD) unmistakable chunky BRAP-BRAP-BRAP idle overlap!
    3-shaft-rev (12-face) periodic overlap-misfire pattern repeats 18 exact times in 2.0 s (9.0 Hz BRAP).
    """
    # Strong nasal BRAP burst followed by exhaust-dilution scavenging lull & soft catch
    brap_pattern = (
        1.55, 1.28, 0.92, 0.40,  # explosive BRAP!
        0.14, 0.20, 0.12, 0.24,  # bridge-port overlap scavenging lull
        0.36, 0.18, 0.30, 0.78,  # catch rising into next BRAP!
    )
    cfg = EnginePhysConfig(
        rpm=1620.0,  # 54 exact eccentric revs in 2.0 s = 18 exact 3-rev BRAP supercycles (9.0 Hz!)
        cycle_deg=360.0,
        cylinders=_CYL_ROTARY4,
        blowdown_tau_ms=0.68,
        blowdown_exp=1.18,  # razor-fast sliding apex-seal port opening!
        shock_mix=0.92,
        rarefaction_depth=0.40,
        rarefaction_tau_mult=2.25,
        rarefaction_delay_mult=1.05,
        rad_corner_hz=2100.0,
        rad_tilt_exp=1.22,
        energy_jitter_frac=0.135,
        time_jitter_ms=0.38,
        tau_jitter_frac=0.09,
        supercycle_pattern=brap_pattern,
        bank0_delay_ms=1.55,
        bank1_delay_ms=2.30,
        pipe0_tau_ms=4.30,
        pipe1_tau_ms=4.75,
        pipe_fwd_gain=0.44,
        pipe_fb_gain=0.48,
        pipe_damp_hz=5600.0,
        xpipe_mix=0.22,
        xpipe_delay_ms=1.05,
        rasp_gain=0.38,
        rasp_lo_hz=280.0,
        rasp_hi_hz=5400.0,
        crackle_gain=0.24,
        crackle_lo_hz=2000.0,
        crackle_hi_hz=9800.0,
        band_lo_hz=45.0,
        band_hi_hz=10400.0,
        exhaust_formants=(
            (108.0, 38.0, 1.4),
            (325.0, 95.0, 2.0),
            (720.0, 190.0, 2.2),
            (1480.0, 360.0, 2.4),
            (2650.0, 550.0, 1.6),
        ),
        intake_gain=0.26,
        intake_tau_mult=1.45,
        intake_angle_offset_deg=-140.0,
        intake_formants=((220.0, 75.0, 1.6), (680.0, 210.0, 1.7)),
        intake_rush_gain=0.10,
        mech_gain=0.05,
        sat_drive=2.15,
        sat_asym=0.18,
        post_formants=((690.0, 180.0, 1.1), (1520.0, 360.0, 1.2)),
        sub_bass_boost_hz=54.0,
        sub_bass_gain=0.35,
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_rotary4_6000(rng: np.random.Generator) -> np.ndarray:
    """6000 RPM 4-Rotor Peripheral-Port (787B) razor-sharp Le Mans shriek."""
    cfg = EnginePhysConfig(
        rpm=6000.0,
        cycle_deg=360.0,
        cylinders=_CYL_ROTARY4,
        blowdown_tau_ms=0.30,
        blowdown_exp=1.16,
        shock_mix=0.95,
        rarefaction_depth=0.30,
        rarefaction_tau_mult=2.05,
        rarefaction_delay_mult=1.05,
        rad_corner_hz=3400.0,
        rad_tilt_exp=1.35,
        energy_jitter_frac=0.09,
        time_jitter_ms=0.15,
        tau_jitter_frac=0.055,
        bank0_delay_ms=1.20,
        bank1_delay_ms=1.72,
        pipe0_tau_ms=2.05,
        pipe1_tau_ms=2.28,
        pipe_fwd_gain=0.46,
        pipe_fb_gain=0.52,
        pipe_damp_hz=8200.0,
        xpipe_mix=0.26,
        xpipe_delay_ms=0.60,
        rasp_gain=0.34,
        rasp_lo_hz=650.0,
        rasp_hi_hz=8600.0,
        crackle_gain=0.26,
        crackle_lo_hz=3000.0,
        crackle_hi_hz=14200.0,
        band_lo_hz=85.0,
        band_hi_hz=14200.0,
        exhaust_formants=(
            (400.0, 88.0, 1.5),
            (1200.0, 240.0, 2.3),
            (2400.0, 460.0, 2.8),
            (3950.0, 720.0, 2.2),
            (5800.0, 1050.0, 1.3),
        ),
        intake_gain=0.28,
        intake_tau_mult=1.35,
        intake_angle_offset_deg=-130.0,
        intake_formants=((420.0, 120.0, 1.4), (1600.0, 360.0, 1.9), (3200.0, 640.0, 1.5)),
        intake_rush_gain=0.12,
        intake_rush_band=(1800.0, 10800.0),
        mech_gain=0.055,
        sat_drive=2.20,
        sat_asym=0.16,
        post_formants=((1220.0, 260.0, 1.1), (2450.0, 480.0, 1.35)),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_tt_i6_low(rng: np.random.Generator) -> np.ndarray:
    """1800 RPM Forged Twin-Turbo Inline-6 (RB26 / 2JZ / S58) deep baritone straight-six rumble."""
    def _low_spool(t: np.ndarray, _f_crank: float, rng_local: np.random.Generator) -> np.ndarray:
        n = t.shape[0]
        # Subtle warm idle/low-boost turbine hush + faint 1850 Hz spool glint
        fm = 0.22 * np.sin(2.0 * math.pi * 1.0 * t)
        whine = 0.08 * np.sin(2.0 * math.pi * 1850.0 * t + fm)
        hush = _circular_fft_shape(
            rng_local.standard_normal(n),
            lambda f: _bandpass_curve(f, 1200.0, 4800.0, order=2.0),
        )
        hush /= float(np.sqrt(np.mean(hush * hush))) + 1e-9
        return whine + 0.09 * hush

    cfg = EnginePhysConfig(
        rpm=1800.0,
        cycle_deg=720.0,
        cylinders=_CYL_I6_TT,
        blowdown_tau_ms=1.65,  # turbine housings smooth sharpest valve edges into deep baritone
        blowdown_exp=1.34,
        shock_mix=0.58,
        rarefaction_depth=0.40,
        rarefaction_tau_mult=2.60,
        rad_corner_hz=1350.0,
        rad_tilt_exp=1.08,
        energy_jitter_frac=0.105,
        time_jitter_ms=0.31,
        tau_jitter_frac=0.07,
        bank0_delay_ms=2.35,
        bank1_delay_ms=3.45,
        pipe0_tau_ms=6.10,
        pipe1_tau_ms=6.55,
        pipe_fwd_gain=0.30,
        pipe_fb_gain=0.32,
        pipe_damp_hz=2800.0,
        xpipe_mix=0.20,
        xpipe_delay_ms=1.10,
        rasp_gain=0.24,
        rasp_lo_hz=180.0,
        rasp_hi_hz=2600.0,
        crackle_gain=0.10,
        crackle_lo_hz=1400.0,
        crackle_hi_hz=5800.0,
        band_lo_hz=32.0,
        band_hi_hz=5600.0,
        exhaust_formants=(
            (90.0, 30.0, 1.8),
            (180.0, 52.0, 1.9),
            (360.0, 110.0, 1.6),
            (820.0, 240.0, 1.4),
        ),
        intake_gain=0.24,
        intake_formants=((170.0, 60.0, 1.6), (520.0, 180.0, 1.3)),
        intake_rush_gain=0.09,
        intake_rush_band=(900.0, 5000.0),
        mech_gain=0.03,
        sat_drive=1.60,
        sat_asym=0.10,
        sub_bass_boost_hz=90.0,
        sub_bass_gain=0.60,
    )
    return _synth_physical_engine(cfg, rng, extra_layer_fn=_low_spool)


def synth_eng_tt_i6_4000(rng: np.random.Generator) -> np.ndarray:
    """4000 RPM Forged Twin-Turbo Inline-6 (RB26 / 2JZ) midrange sing + twin-impeller whistle."""
    def _twin_turbo_spool(t: np.ndarray, _f_crank: float, rng_local: np.random.Generator) -> np.ndarray:
        n = t.shape[0]
        # Twin slightly-detuned turbo impellers (3400 Hz & 3426 Hz + 6800 Hz 2nd blade pass)
        fm = 0.28 * np.sin(2.0 * math.pi * 1.5 * t) + 0.10 * np.sin(2.0 * math.pi * 3.5 * t + 0.7)
        whistle = (
            0.34 * np.sin(2.0 * math.pi * 3400.0 * t + fm)
            + 0.24 * np.sin(2.0 * math.pi * 3426.0 * t - fm + 1.1)
            + 0.12 * np.sin(2.0 * math.pi * 6800.0 * t + 2.0 * fm)
        )
        # Pressurized charge-pipe / cone-filter air rush
        air = _circular_fft_shape(
            rng_local.standard_normal(n),
            lambda f: _bandpass_curve(f, 1600.0, 7800.0, order=2.0)
            * _resonator_bank(f, ((3410.0, 480.0, 2.0),)),
        )
        air /= float(np.sqrt(np.mean(air * air))) + 1e-9
        return whistle + 0.28 * air

    cfg = EnginePhysConfig(
        rpm=4000.0,
        cycle_deg=720.0,
        cylinders=_CYL_I6_TT,
        blowdown_tau_ms=0.78,
        blowdown_exp=1.32,
        shock_mix=0.60,
        rarefaction_depth=0.36,
        rarefaction_tau_mult=2.45,
        rad_corner_hz=1750.0,
        rad_tilt_exp=1.12,
        energy_jitter_frac=0.09,
        time_jitter_ms=0.21,
        tau_jitter_frac=0.06,
        bank0_delay_ms=1.70,
        bank1_delay_ms=2.65,
        pipe0_tau_ms=3.35,
        pipe1_tau_ms=3.70,
        pipe_fwd_gain=0.32,
        pipe_fb_gain=0.36,
        pipe_damp_hz=4200.0,
        xpipe_mix=0.22,
        xpipe_delay_ms=0.90,
        rasp_gain=0.28,
        rasp_lo_hz=320.0,
        rasp_hi_hz=4500.0,
        crackle_gain=0.15,
        crackle_lo_hz=2000.0,
        crackle_hi_hz=8000.0,
        band_lo_hz=46.0,
        band_hi_hz=7200.0,
        exhaust_formants=(
            (201.0, 56.0, 1.7),
            (402.0, 105.0, 1.9),
            (920.0, 230.0, 1.8),
            (1840.0, 420.0, 1.5),
        ),
        intake_gain=0.26,
        intake_formants=((380.0, 110.0, 1.5), (1050.0, 280.0, 1.4)),
        intake_rush_gain=0.12,
        intake_rush_band=(1400.0, 7200.0),
        mech_gain=0.035,
        sat_drive=1.70,
        sat_asym=0.11,
        post_formants=((402.0, 120.0, 0.8), (1120.0, 300.0, 0.85)),
    )
    return _synth_physical_engine(cfg, rng, extra_layer_fn=_twin_turbo_spool)


def synth_eng_v8_cross_low(rng: np.random.Generator) -> np.ndarray:
    """1500 RPM Cross-Plane V8 (Vela GT / Muscle) heavy unequal-bank lope & deep burble."""
    cfg = EnginePhysConfig(
        rpm=1500.0,
        cycle_deg=720.0,
        cylinders=_CYL_V8_CROSS,
        blowdown_tau_ms=2.05,
        blowdown_exp=1.30,
        shock_mix=0.62,
        rarefaction_depth=0.44,
        rarefaction_tau_mult=2.65,
        rad_corner_hz=1150.0,
        rad_tilt_exp=1.02,
        energy_jitter_frac=0.135,
        time_jitter_ms=0.40,
        tau_jitter_frac=0.09,
        bank0_delay_ms=2.10,
        bank1_delay_ms=4.55,  # strong unequal dual-pipe muscle burble!
        pipe0_tau_ms=7.20,
        pipe1_tau_ms=8.05,
        pipe_fwd_gain=0.40,
        pipe_fb_gain=0.40,
        pipe_damp_hz=3200.0,
        xpipe_mix=0.28,  # H-pipe bass coupling
        xpipe_delay_ms=1.65,
        rasp_gain=0.36,
        rasp_lo_hz=160.0,
        rasp_hi_hz=2900.0,
        crackle_gain=0.16,
        crackle_lo_hz=1200.0,
        crackle_hi_hz=6600.0,
        band_lo_hz=28.0,
        band_hi_hz=6200.0,
        exhaust_formants=(
            (50.0, 22.0, 1.5),
            (75.0, 26.0, 1.7),
            (100.0, 34.0, 1.9),
            (250.0, 78.0, 1.8),
            (580.0, 175.0, 1.6),
            (1150.0, 320.0, 1.2),
        ),
        intake_gain=0.22,
        intake_formants=((135.0, 48.0, 1.6), (420.0, 150.0, 1.4)),
        intake_rush_gain=0.07,
        mech_gain=0.035,
        sat_drive=1.95,
        sat_asym=0.15,
        post_formants=((100.0, 42.0, 0.75), (480.0, 160.0, 0.85)),
        sub_bass_boost_hz=75.0,
        sub_bass_gain=0.65,
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v8_cross_4200(rng: np.random.Generator) -> np.ndarray:
    """4200 RPM Cross-Plane V8 (Vela GT / Muscle) throaty, thunderous roar."""
    cfg = EnginePhysConfig(
        rpm=4200.0,
        cycle_deg=720.0,
        cylinders=_CYL_V8_CROSS,
        blowdown_tau_ms=0.72,
        blowdown_exp=1.26,
        shock_mix=0.78,
        rarefaction_depth=0.38,
        rarefaction_tau_mult=2.40,
        rad_corner_hz=2100.0,
        rad_tilt_exp=1.22,
        energy_jitter_frac=0.105,
        time_jitter_ms=0.23,
        tau_jitter_frac=0.07,
        bank0_delay_ms=1.55,
        bank1_delay_ms=3.15,
        pipe0_tau_ms=3.40,
        pipe1_tau_ms=3.95,
        pipe_fwd_gain=0.40,
        pipe_fb_gain=0.42,
        pipe_damp_hz=4800.0,
        xpipe_mix=0.26,
        xpipe_delay_ms=1.10,
        rasp_gain=0.38,
        rasp_lo_hz=280.0,
        rasp_hi_hz=5200.0,
        crackle_gain=0.22,
        crackle_lo_hz=2000.0,
        crackle_hi_hz=9800.0,
        band_lo_hz=36.0,
        band_hi_hz=9200.0,
        exhaust_formants=(
            (140.0, 45.0, 1.5),
            (280.0, 78.0, 1.9),
            (590.0, 165.0, 1.9),
            (1220.0, 310.0, 1.9),
            (2250.0, 480.0, 1.4),
        ),
        intake_gain=0.26,
        intake_formants=((280.0, 90.0, 1.5), (860.0, 240.0, 1.5)),
        intake_rush_gain=0.10,
        mech_gain=0.04,
        sat_drive=2.05,
        sat_asym=0.15,
        post_formants=((280.0, 90.0, 0.8), (1180.0, 320.0, 1.0)),
        sub_bass_boost_hz=140.0,
        sub_bass_gain=0.40,
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v8_flat_low(rng: np.random.Generator) -> np.ndarray:
    """2000 RPM Flat-Plane V8 (Fiamma / GT3) crisp, taut Italian metallic growl."""
    cfg = EnginePhysConfig(
        rpm=2000.0,
        cycle_deg=720.0,
        cylinders=_CYL_V8_FLAT,
        blowdown_tau_ms=1.06,
        blowdown_exp=1.25,
        shock_mix=0.76,
        rarefaction_depth=0.34,
        rarefaction_tau_mult=2.35,
        rad_corner_hz=2000.0,
        rad_tilt_exp=1.22,
        energy_jitter_frac=0.10,
        time_jitter_ms=0.24,
        tau_jitter_frac=0.065,
        bank0_delay_ms=1.65,
        bank1_delay_ms=1.92,  # tight equal-length 4-into-1 tubular headers
        pipe0_tau_ms=4.15,
        pipe1_tau_ms=4.38,
        pipe_fwd_gain=0.40,
        pipe_fb_gain=0.44,
        pipe_damp_hz=5400.0,
        xpipe_mix=0.25,
        xpipe_delay_ms=0.70,
        rasp_gain=0.30,
        rasp_lo_hz=360.0,
        rasp_hi_hz=4800.0,
        crackle_gain=0.19,
        crackle_lo_hz=2200.0,
        crackle_hi_hz=9800.0,
        band_lo_hz=45.0,
        band_hi_hz=10600.0,
        exhaust_formants=(
            (132.0, 42.0, 1.5),
            (396.0, 110.0, 1.8),
            (960.0, 240.0, 2.2),
            (1960.0, 420.0, 1.8),
        ),
        intake_gain=0.28,
        intake_formants=((260.0, 82.0, 1.5), (840.0, 230.0, 1.6)),
        intake_rush_gain=0.09,
        mech_gain=0.045,
        sat_drive=1.80,
        sat_asym=0.13,
        post_formants=((1020.0, 260.0, 1.05), (2050.0, 450.0, 0.95)),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_v8_flat_5500(rng: np.random.Generator) -> np.ndarray:
    """5500 RPM Flat-Plane V8 (Fiamma / GT3) high-revving Italian Inconel snarl."""
    cfg = EnginePhysConfig(
        rpm=5500.0,
        cycle_deg=720.0,
        cylinders=_CYL_V8_FLAT,
        blowdown_tau_ms=0.35,
        blowdown_exp=1.22,
        shock_mix=0.88,
        rarefaction_depth=0.29,
        rarefaction_tau_mult=2.15,
        rad_corner_hz=3000.0,
        rad_tilt_exp=1.34,
        energy_jitter_frac=0.088,
        time_jitter_ms=0.15,
        tau_jitter_frac=0.055,
        bank0_delay_ms=1.35,
        bank1_delay_ms=1.55,
        pipe0_tau_ms=2.10,
        pipe1_tau_ms=2.22,
        pipe_fwd_gain=0.43,
        pipe_fb_gain=0.49,
        pipe_damp_hz=7600.0,
        xpipe_mix=0.28,
        xpipe_delay_ms=0.55,
        rasp_gain=0.34,
        rasp_lo_hz=600.0,
        rasp_hi_hz=7600.0,
        crackle_gain=0.25,
        crackle_lo_hz=2800.0,
        crackle_hi_hz=13800.0,
        band_lo_hz=65.0,
        band_hi_hz=13800.0,
        exhaust_formants=(
            (368.0, 92.0, 1.5),
            (1104.0, 240.0, 2.3),
            (2250.0, 460.0, 2.6),
            (3680.0, 700.0, 2.0),
        ),
        intake_gain=0.29,
        intake_formants=((480.0, 130.0, 1.5), (1460.0, 320.0, 1.9), (2900.0, 580.0, 1.5)),
        intake_rush_gain=0.11,
        intake_rush_band=(1500.0, 9600.0),
        mech_gain=0.05,
        sat_drive=2.00,
        sat_asym=0.14,
        post_formants=((1150.0, 280.0, 1.15), (2320.0, 460.0, 1.25)),
    )
    return _synth_physical_engine(cfg, rng)


def synth_eng_sc_v8_whine(rng: np.random.Generator) -> np.ndarray:
    """4000 RPM Supercharged Cross-Plane V8 (Hellhound) + screaming Roots/twin-screw blower."""
    def _roots_blower(t: np.ndarray, f_crank: float, rng_local: np.random.Generator) -> np.ndarray:
        n = t.shape[0]
        # Exact integer-cycle blower lobe-pass frequencies locked to crank (f_crank = 67.0 Hz)
        f_lobe = 2680.0  # 40 * f_crank (screaming twin-screw/Roots whine band)
        f_sub = 1340.0
        belt_fm = (
            0.34 * np.sin(2.0 * math.pi * 1.0 * t)
            + 0.14 * np.sin(2.0 * math.pi * 3.0 * t + 0.6)
            + 0.08 * np.sin(2.0 * math.pi * f_crank * t + 1.4)
        )
        whine = (
            0.24 * np.sin(2.0 * math.pi * f_sub * t + 0.5 * belt_fm + 0.3)
            + 0.78 * np.sin(2.0 * math.pi * f_lobe * t + belt_fm)
            + 0.20 * np.sin(2.0 * math.pi * (f_lobe + f_sub) * t + 1.5 * belt_fm + 0.9)
            + 0.34 * np.sin(2.0 * math.pi * (2.0 * f_lobe) * t + 2.0 * belt_fm + 0.5)
            + 0.12 * np.sin(2.0 * math.pi * (3.0 * f_lobe) * t + 3.0 * belt_fm + 1.3)
            # Mechanical pulley/rotor runout sidebands
            + 0.13 * np.sin(2.0 * math.pi * (f_lobe - f_crank) * t + belt_fm + 0.4)
            + 0.13 * np.sin(2.0 * math.pi * (f_lobe + f_crank) * t + belt_fm + 2.0)
        )
        # Subtle nonlinear aluminum blower-case bite
        whine = np.tanh(whine * 1.15)
        # High-pressure intake case rush around lobe-pass band
        sc_air = _circular_fft_shape(
            rng_local.standard_normal(n),
            lambda f: _bandpass_curve(f, 1700.0, 8800.0, order=2.0)
            * _resonator_bank(f, ((f_lobe, 380.0, 2.0), (2.0 * f_lobe, 650.0, 1.2))),
        )
        sc_air /= float(np.sqrt(np.mean(sc_air * sc_air))) + 1e-9
        return 0.80 * whine + 0.24 * sc_air

    cfg = EnginePhysConfig(
        rpm=4000.0,
        cycle_deg=720.0,
        cylinders=_CYL_V8_CROSS,
        blowdown_tau_ms=0.74,
        blowdown_exp=1.28,
        shock_mix=0.74,
        rarefaction_depth=0.38,
        rarefaction_tau_mult=2.40,
        rad_corner_hz=1950.0,
        rad_tilt_exp=1.16,
        energy_jitter_frac=0.105,
        time_jitter_ms=0.24,
        tau_jitter_frac=0.07,
        bank0_delay_ms=1.60,
        bank1_delay_ms=3.20,
        pipe0_tau_ms=3.55,
        pipe1_tau_ms=4.10,
        pipe_fwd_gain=0.40,
        pipe_fb_gain=0.42,
        pipe_damp_hz=4500.0,
        xpipe_mix=0.26,
        xpipe_delay_ms=1.15,
        rasp_gain=0.34,
        rasp_lo_hz=260.0,
        rasp_hi_hz=4600.0,
        crackle_gain=0.18,
        crackle_lo_hz=1800.0,
        crackle_hi_hz=9000.0,
        band_lo_hz=35.0,
        band_hi_hz=8600.0,
        exhaust_formants=(
            (134.0, 45.0, 1.5),
            (268.0, 75.0, 1.8),
            (620.0, 175.0, 1.7),
            (1180.0, 300.0, 1.5),
        ),
        intake_gain=0.18,
        intake_formants=((260.0, 85.0, 1.4), (780.0, 220.0, 1.3)),
        intake_rush_gain=0.08,
        mech_gain=0.04,
        sat_drive=1.95,
        sat_asym=0.14,
        sub_bass_boost_hz=134.0,
        sub_bass_gain=0.40,
    )
    return _synth_physical_engine(cfg, rng, extra_layer_fn=_roots_blower)


# ---- Drivetrain, Induction & Exhaust FX Synthesizers (3 Stems) -----------------------------------


def synth_gear_whine_straightcut(rng: np.random.Generator) -> np.ndarray:
    """
    2.0 s seamless straight-cut sequential dog-box gearbox tooth-mesh whine:
      Raw GT3 / M3 GTR onboard transmission scream!
      Tooth-mesh f0 = 1200.0 Hz (2400 cycles / 2 s) + trapezoidal tooth-contact harmonics up to
      5th order, shaft runout FM/AM sidebands (±40 Hz, ±80 Hz), aluminum gearbox housing resonances,
      and dry needle-bearing mechanical carrier hiss.
    """
    dur = 2.0
    n = int(SAMPLE_RATE * dur)
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    f_mesh = 1200.0
    f_shaft = 40.0

    # Shaft eccentricity & gear-lash load micro-modulation (exact integer cycles)
    am = (
        1.0
        + 0.11 * np.sin(2.0 * math.pi * f_shaft * t)
        + 0.05 * np.sin(2.0 * math.pi * (2.0 * f_shaft) * t + 0.9)
        + 0.03 * np.sin(2.0 * math.pi * 1.5 * t + 0.4)
    )
    pm = (
        0.18 * np.sin(2.0 * math.pi * f_shaft * t + 0.3)
        + 0.06 * np.sin(2.0 * math.pi * (2.0 * f_shaft) * t + 1.7)
    )

    # Raw straight-cut tooth-contact waveform + countershaft sub-mesh + runout sidebands
    whine = (
        1.00 * np.sin(2.0 * math.pi * f_mesh * t + pm)
        + 0.58 * np.sin(2.0 * math.pi * (2.0 * f_mesh) * t + 2.0 * pm + 0.65)
        + 0.32 * np.sin(2.0 * math.pi * (3.0 * f_mesh) * t + 3.0 * pm + 1.45)
        + 0.16 * np.sin(2.0 * math.pi * (4.0 * f_mesh) * t + 4.0 * pm + 2.15)
        + 0.08 * np.sin(2.0 * math.pi * (5.0 * f_mesh) * t + 5.0 * pm + 0.40)
        + 0.16 * np.sin(2.0 * math.pi * 600.0 * t + 0.5 * pm + 0.8)  # countershaft half-mesh
        + 0.20 * np.sin(2.0 * math.pi * (f_mesh - f_shaft) * t + 0.2)
        + 0.20 * np.sin(2.0 * math.pi * (f_mesh + f_shaft) * t + 1.9)
        + 0.10 * np.sin(2.0 * math.pi * (2.0 * f_mesh - f_shaft) * t + 0.7)
        + 0.10 * np.sin(2.0 * math.pi * (2.0 * f_mesh + f_shaft) * t + 2.4)
    ) * am

    # Nonlinear steel-on-steel tooth-impact bite
    whine = _asymmetric_saturate(whine, drive=1.55, asym=0.08)

    # Aluminum sequential casing resonances & waveguide ring
    whine = _circular_fft_shape(
        whine,
        lambda f: _bandpass_curve(f, 420.0, 11500.0, order=2.0)
        * _resonator_bank(
            f,
            ((1200.0, 150.0, 1.7), (2400.0, 290.0, 1.5), (3600.0, 450.0, 1.2), (4850.0, 620.0, 0.9)),
        ),
    )

    # Dog-ring & bearing rattle carrier hiss modulated by tooth mesh
    bearing = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 1800.0, 11000.0, order=2.0)
        * _resonator_bank(f, ((2400.0, 520.0, 1.4), (5200.0, 1100.0, 1.2))),
    )
    bearing /= float(np.sqrt(np.mean(bearing * bearing))) + 1e-9
    whine_rms = float(np.sqrt(np.mean(whine * whine))) + 1e-9
    mesh_env = 0.72 + 0.28 * np.sin(2.0 * math.pi * f_shaft * t)

    return _finalize_loop(whine + 0.20 * whine_rms * bearing * mesh_env, target_rms_dbfs=-13.5)


def synth_turbo_flutter_bov(rng: np.random.Generator) -> np.ndarray:
    """
    1.1 s one-shot compressor-surge blow-off valve flutter ("stu-tu-tu-tu-tu"):
      Crisp, visceral 5-pulse JDM dose-pipe surge with decelerating spacing, aluminum hard-pipe
      waveguide comb resonance, pressurized turbulent air chop, and spinning-down compressor chirp.
    """
    dur = 1.1
    n = int(SAMPLE_RATE * dur)
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE

    # 5 primary compressor-stall pulses + faint 6th tail breath (decelerating surge cadence)
    pulses = [
        # (start_s, tau_s, amp, pitch_hz)
        (0.012, 0.013, 1.30, 2600.0),  # razor-crisp initial "STU-"
        (0.105, 0.015, 1.05, 2220.0),  # "-tu-"
        (0.220, 0.018, 0.84, 1900.0),  # "-tu-"
        (0.360, 0.021, 0.62, 1620.0),  # "-tu-"
        (0.525, 0.025, 0.42, 1390.0),  # "-tu"
        (0.715, 0.032, 0.18, 1210.0),  # soft trailing breath
    ]

    chop_env = np.zeros(n, dtype=np.float64)
    blade_chirp = np.zeros(n, dtype=np.float64)
    for t0, tau, amp, f_center in pulses:
        dt = np.maximum(t - t0, 0.0)
        gate = (t >= t0).astype(np.float64)
        # Fast-rise asymmetric reverse-pressure stall envelope with deep trough between pulses
        u = dt / tau
        p_env = amp * (u ** 0.70) * np.exp(-u) * ((math.e / 0.70) ** 0.70) * gate
        chop_env += p_env

        # Per-pulse descending compressor blade-pass resonant chirp
        f_inst = f_center * (0.74 + 0.36 * np.exp(-dt / (tau * 1.25)))
        phi = 2.0 * math.pi * np.cumsum(f_inst * gate) / SAMPLE_RATE
        blade_chirp += p_env * (
            0.38 * np.sin(phi)
            + 0.20 * np.sin(2.0 * phi + 0.5)
            + 0.09 * np.sin(3.0 * phi + 1.2)
        )

    # Low steady pressurized bleed underneath the 5 sharp surge chops
    bleed_env = 0.06 * np.exp(-t / 0.24) * np.clip(t / 0.010, 0.0, 1.0)
    full_env = chop_env + bleed_env

    # Multi-band turbulent pressurized intake air (crossfades brighter early -> darker late)
    air_hi = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 2200.0, 9600.0, order=2.5)
        * _resonator_bank(f, ((3500.0, 580.0, 1.9), (5800.0, 950.0, 1.3))),
    )
    air_mid = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 820.0, 3800.0, order=2.5)
        * _resonator_bank(f, ((1480.0, 260.0, 2.3), (2280.0, 420.0, 1.7))),
    )
    air_lo = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 320.0, 1150.0, order=2.0)
        * _resonator_bank(f, ((620.0, 150.0, 1.5),)),
    )
    for arr in (air_hi, air_mid, air_lo):
        arr /= float(np.sqrt(np.mean(arr * arr))) + 1e-9

    hi_w = np.exp(-t / 0.24)
    air = (0.82 * hi_w * air_hi + 1.08 * air_mid + 0.38 * air_lo) * full_env

    # Combine air chop + blade chirp and run through an aluminum intercooler intake-pipe waveguide!
    raw = air + 0.45 * blade_chirp
    piped = _circular_fft_shape(
        raw,
        lambda f: _waveguide_pipe_tf(
            f,
            delay_ms=0.2,
            pipe_tau_ms=1.62,  # ~617 Hz / 1235 Hz / 1852 Hz hollow aluminum dose-pipe comb!
            fwd_gain=0.34,
            fb_gain=0.48,
            damp_hz=6200.0,
        )
        * _bandpass_curve(f, 260.0, 11200.0, order=2.0),
    )
    piped = _asymmetric_saturate(piped, drive=1.40, asym=0.08, dry_mix=0.35)
    return _finalize_oneshot(piped, target_rms_dbfs=-14.0, fade_in_ms=2.0, fade_out_ms=65.0)


def synth_exhaust_backfire_pop(rng: np.random.Generator) -> np.ndarray:
    """
    0.55 s one-shot overrun exhaust detonation / shift-cut shotgun bang:
      Violent unburnt-fuel shotgun crack + chest-thumping sub-bass shockwave + secondary overrun
      crackle + damped titanium tailpipe metallic waveguide ring.
    """
    dur = 0.55
    n = int(SAMPLE_RATE * dur)
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE

    # Uncorrelated broadband noise sources for sharp detonation cracks & exhaust roar
    crack_src1 = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 240.0, 14500.0, order=2.0)
        * _resonator_bank(f, ((540.0, 190.0, 1.6), (1850.0, 500.0, 1.9), (4600.0, 1200.0, 1.5))),
    )
    crack_src1 /= float(np.sqrt(np.mean(crack_src1 * crack_src1))) + 1e-9

    crack_src2 = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 280.0, 12500.0, order=2.0)
        * _resonator_bank(f, ((680.0, 220.0, 1.5), (2150.0, 560.0, 1.6))),
    )
    crack_src2 /= float(np.sqrt(np.mean(crack_src2 * crack_src2))) + 1e-9

    # 1. Primary violent shotgun detonation at t = 6 ms
    t1 = np.maximum(t - 0.006, 0.0)
    g1 = (t >= 0.006).astype(np.float64)
    # Instantaneous supersonic shock front + chest-thump downward pitch sweep (210 -> 44 Hz)
    f_th1 = 44.0 + 166.0 * np.exp(-t1 / 0.010)
    phi1 = 2.0 * math.pi * np.cumsum(f_th1 * g1) / SAMPLE_RATE
    thump1 = np.sin(phi1) * np.exp(-t1 / 0.042) * np.clip(t1 / 0.0006, 0.0, 1.0) * g1
    # Sharp shock transient spike
    shock1 = (t1 / 0.0010) ** 0.65 * np.exp(-t1 / 0.0010) * g1
    crack1 = crack_src1 * (1.85 * np.exp(-t1 / 0.011) + 0.55 * np.exp(-t1 / 0.042)) * g1

    # 2. Secondary overrun pop at t = 86 ms
    t2 = np.maximum(t - 0.086, 0.0)
    g2 = (t >= 0.086).astype(np.float64)
    f_th2 = 58.0 + 140.0 * np.exp(-t2 / 0.009)
    phi2 = 2.0 * math.pi * np.cumsum(f_th2 * g2) / SAMPLE_RATE
    thump2 = 0.62 * np.sin(phi2) * np.exp(-t2 / 0.030) * np.clip(t2 / 0.0008, 0.0, 1.0) * g2
    crack2 = 0.92 * crack_src2 * np.exp(-t2 / 0.014) * g2

    # 3. Trailing hot-exhaust spit crackle at t = 162 ms
    t3 = np.maximum(t - 0.162, 0.0)
    g3 = (t >= 0.162).astype(np.float64)
    crack3 = 0.44 * crack_src1 * np.exp(-t3 / 0.012) * g3

    # 4. Titanium tailpipe metallic modal ring + turbulent hot-gas tail
    pipe_env = np.exp(-t1 / 0.130) * g1
    ti_ring = (
        0.42 * np.sin(2.0 * math.pi * 114.0 * t1)
        + 0.28 * np.sin(2.0 * math.pi * 242.0 * t1 + 0.7)
        + 0.20 * np.sin(2.0 * math.pi * 515.0 * t1 + 1.5)
        + 0.16 * np.sin(2.0 * math.pi * 1380.0 * t1 + 2.3) * np.exp(-t1 / 0.055)
        + 0.12 * np.sin(2.0 * math.pi * 2780.0 * t1 + 0.4) * np.exp(-t1 / 0.038)
    ) * pipe_env

    tail_roar = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 75.0, 1750.0, order=2.0),
    )
    tail_roar /= float(np.sqrt(np.mean(tail_roar * tail_roar))) + 1e-9
    tail_roar = tail_roar * (0.48 * np.exp(-t1 / 0.145) * g1)

    raw = 1.65 * thump1 + 1.35 * shock1 + 2.15 * crack1 + thump2 + crack2 + crack3 + ti_ring + tail_roar
    # Pass through resonant exhaust tailpipe waveguide, keeping explosive shotgun transient punch
    piped = _circular_fft_shape(
        raw,
        lambda f: _waveguide_pipe_tf(
            f,
            delay_ms=0.1,
            pipe_tau_ms=3.90,
            fwd_gain=0.35,
            fb_gain=0.42,
            damp_hz=5800.0,
        ),
    )
    sat = _asymmetric_saturate(piped, drive=1.65, asym=0.14, dry_mix=0.48)
    return _finalize_oneshot(sat, target_rms_dbfs=-14.5, fade_in_ms=1.0, fade_out_ms=70.0)


# ---- Tyre & Road Surface Synthesizers (3 Stems, 2.0 s Seamless Loops) ----------------------------


def synth_tyre_scrub_dry(rng: np.random.Generator) -> np.ndarray:
    """
    2.0 s seamless dry asphalt tyre slip / screech / howl loop:
      Organic multi-band rubber stick-slip tread resonances (740, 1140, 1680, 2480 Hz) with
      stochastic slip modulation, gritty dry-asphalt rubber tearing texture, and warm 225 Hz
      toroidal tyre cavity hump.
    """
    dur = 2.0
    n = int(SAMPLE_RATE * dur)
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE

    # Multi-band narrowband stick-slip noise (organic, non-robotic tyre howl)
    squeal_bands = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 520.0, 4200.0, order=2.0)
        * (
            3.0 / (1.0 + ((f - 740.0) / 52.0) ** 2)
            + 3.4 / (1.0 + ((f - 1140.0) / 78.0) ** 2)
            + 2.4 / (1.0 + ((f - 1680.0) / 115.0) ** 2)
            + 1.5 / (1.0 + ((f - 2480.0) / 180.0) ** 2)
        ),
    )
    squeal_bands /= float(np.sqrt(np.mean(squeal_bands * squeal_bands))) + 1e-9

    # Organic slow circular slip-angle wander envelope (2-11 Hz)
    mod_raw = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 1.5, 10.5, order=2.0),
    )
    mod = 1.0 + 0.28 * (mod_raw / (float(np.std(mod_raw)) + 1e-9))

    # Subtle drifting stick-slip micro-chirp ridge (phase-modulated by circular low-freq noise!)
    fm_noise1 = _circular_fft_shape(rng.standard_normal(n), lambda f: _bandpass_curve(f, 1.0, 8.0, order=2.0))
    fm_noise1 /= float(np.std(fm_noise1)) + 1e-9
    fm_noise2 = _circular_fft_shape(rng.standard_normal(n), lambda f: _bandpass_curve(f, 1.5, 9.5, order=2.0))
    fm_noise2 /= float(np.std(fm_noise2)) + 1e-9

    coherent = (
        0.22 * np.sin(2.0 * math.pi * 880.0 * t + 3.2 * fm_noise1)
        + 0.17 * np.sin(2.0 * math.pi * 1340.0 * t + 3.8 * fm_noise2)
        + 0.09 * np.sin(2.0 * math.pi * 2120.0 * t + 2.4 * fm_noise1 + 1.1)
    )

    # Coarse asphalt rubber tearing & grit + 225 Hz toroidal tyre cavity resonance
    scrub = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 140.0, 6400.0, order=2.0)
        * _resonator_bank(f, ((225.0, 38.0, 1.8), (620.0, 220.0, 1.1), (2900.0, 950.0, 0.9))),
    )
    scrub /= float(np.sqrt(np.mean(scrub * scrub))) + 1e-9

    sig = (0.88 * squeal_bands + coherent) * mod + 0.62 * scrub
    sig = _asymmetric_saturate(sig, drive=1.35, asym=0.05)
    return _finalize_loop(sig, target_rms_dbfs=-13.5)


def synth_tyre_spray_wet(rng: np.random.Generator) -> np.ndarray:
    """
    2.0 s seamless wet-asphalt standing-water hydroplane spray & wheel-arch splash loop:
      Crisp high-frequency spray hiss (2.0-14.5 kHz) + turbulent water-channeling mid rush +
      discrete circular wheel-arch droplet/slap impacts + 225 Hz wet tyre cavity rumble.
    """
    dur = 2.0
    n = int(SAMPLE_RATE * dur)

    # High-frequency hydroplane spray hiss
    spray_hi = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 2100.0, 14500.0, order=2.0)
        * _resonator_bank(f, ((3600.0, 1200.0, 1.5), (7800.0, 2400.0, 1.3))),
    )
    # Tread-groove water evacuation turbulent mid body
    splash_mid = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 420.0, 2400.0, order=2.0)
        * _resonator_bank(f, ((920.0, 340.0, 1.4),)),
    )
    # Standing-water low-mid puddle rumble + 225 Hz tyre cavity
    puddle_lo = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 110.0, 520.0, order=2.0)
        * _resonator_bank(f, ((225.0, 42.0, 1.3),)),
    )
    for arr in (spray_hi, splash_mid, puddle_lo):
        arr /= float(np.sqrt(np.mean(arr * arr))) + 1e-9

    # Circular wheel-arch plastic-liner droplet splash impacts (160 randomized micro-slaps)
    drop_env = np.zeros(n, dtype=np.float64)
    ir_len = int(SAMPLE_RATE * 0.018)
    t_ir = np.arange(ir_len, dtype=np.float64) / SAMPLE_RATE
    ir_idx = np.arange(ir_len, dtype=np.int64)
    for _ in range(160):
        pos = int(rng.integers(0, n))
        tau_d = float(rng.uniform(0.0012, 0.0042))
        amp_d = float(rng.uniform(0.35, 1.25))
        pulse = amp_d * np.exp(-t_ir / tau_d) * np.clip(t_ir / 0.0003, 0.0, 1.0)
        drop_env[(pos + ir_idx) % n] += pulse

    drop_noise = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 900.0, 6800.0, order=2.0)
        * _resonator_bank(f, ((1950.0, 620.0, 1.5),)),
    )
    drop_noise /= float(np.sqrt(np.mean(drop_noise * drop_noise))) + 1e-9
    droplets = drop_noise * (drop_env / (float(np.percentile(drop_env, 98)) + 1e-9))

    # Organic circular shimmer envelopes
    shimmer_hi = _circular_fft_shape(rng.standard_normal(n), lambda f: _bandpass_curve(f, 2.5, 12.0, order=2.0))
    shimmer_hi = 1.0 + 0.25 * (shimmer_hi / (float(np.std(shimmer_hi)) + 1e-9))

    shimmer_mid = _circular_fft_shape(rng.standard_normal(n), lambda f: _bandpass_curve(f, 1.5, 8.0, order=2.0))
    shimmer_mid = 1.0 + 0.30 * (shimmer_mid / (float(np.std(shimmer_mid)) + 1e-9))

    sig = (
        0.92 * spray_hi * shimmer_hi
        + 0.65 * splash_mid * shimmer_mid
        + 0.42 * droplets
        + 0.30 * puddle_lo
    )
    return _finalize_loop(sig, target_rms_dbfs=-13.5)


def synth_kerb_rumble_strip(rng: np.random.Generator) -> np.ndarray:
    """
    2.0 s seamless hollow suspension + tyre thudding kerb rumble-strip impact loop:
      64 exact kerb block strikes in 2.0 s (f0 = 32.0 Hz). Each impact drives heavy unsprung-mass
      suspension thump, hollow chassis knock (118 Hz), Simcenter 225 Hz toroidal tyre cavity ring,
      and concrete/painted-kerb contact grit with realistic per-block amplitude & timing jitter.
    """
    dur = 2.0
    n = int(SAMPLE_RATE * dur)
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    f_kerb = 32.0
    num_strikes = int(round(f_kerb * dur))  # 64 exact strikes in 2.0 s
    stride = n / num_strikes  # 1500.0 samples per strike

    ir_len = int(SAMPLE_RATE * 0.115)
    t_ir = np.arange(ir_len, dtype=np.float64) / SAMPLE_RATE
    ir_idx = np.arange(ir_len, dtype=np.int64)

    # 1. Heavy unsprung-mass suspension thump (78 Hz -> 32 Hz)
    f_thump = 32.0 + 46.0 * np.exp(-t_ir / 0.011)
    phi_thump = 2.0 * math.pi * np.cumsum(f_thump) / SAMPLE_RATE
    thump = 1.15 * np.sin(phi_thump) * np.exp(-t_ir / 0.025) * np.clip(t_ir / 0.0012, 0.0, 1.0)

    # 2. Hollow suspension strut / chassis floor knock (118 Hz damped mode)
    strut = 0.58 * np.sin(2.0 * math.pi * 118.0 * t_ir + 0.3) * np.exp(-t_ir / 0.016) * np.clip(t_ir / 0.0008, 0.0, 1.0)

    # 3. 225 Hz toroidal tyre cavity resonance ring (matches OpenGrid CavityRingGain)
    cavity = (
        0.62 * np.sin(2.0 * math.pi * 225.0 * t_ir)
        + 0.22 * np.sin(2.0 * math.pi * 450.0 * t_ir + 0.6)
    ) * np.exp(-t_ir / 0.022) * np.clip(t_ir / 0.0010, 0.0, 1.0)

    strike_ir = thump + strut + cavity
    grit_pulse = np.exp(-t_ir / 0.0085) * np.clip(t_ir / 0.0006, 0.0, 1.0)

    impulses = np.zeros(n, dtype=np.float64)
    grit_env = np.zeros(n, dtype=np.float64)

    for k in range(num_strikes):
        # Small organic kerb block timing jitter (±0.35 ms) & impact energy jitter (±14%)
        t_jit_samp = int(round(float(rng.normal(0.0, 0.00025 * SAMPLE_RATE))))
        start = (int(round(k * stride)) + t_jit_samp) % n
        amp_var = float(np.clip(rng.normal(1.0, 0.12), 0.72, 1.28))
        dest = (start + ir_idx) % n
        impulses[dest] += amp_var * strike_ir
        grit_env[dest] += amp_var * grit_pulse

    grit_noise = _circular_fft_shape(
        rng.standard_normal(n),
        lambda f: _bandpass_curve(f, 240.0, 2800.0, order=2.0)
        * _resonator_bank(f, ((225.0, 35.0, 1.4), (780.0, 250.0, 1.2), (1650.0, 480.0, 0.9))),
    )
    grit_noise /= float(np.sqrt(np.mean(grit_noise * grit_noise))) + 1e-9
    imp_rms = float(np.sqrt(np.mean(impulses * impulses))) + 1e-9

    # Reinforce fundamental kerb buzz (32/64/96 Hz exact integer cycles)
    hum = _harmonic_sum(t, dur, [(32.0, 0.24, 0.0), (64.0, 0.22, 0.4), (96.0, 0.14, 1.1)])
    sig = impulses + 0.85 * imp_rms * grit_noise * grit_env + 0.42 * imp_rms * hum
    sig = _asymmetric_saturate(sig, drive=1.45, asym=0.07, dry_mix=0.35)
    return _finalize_loop(sig, target_rms_dbfs=-13.5)


# ---- Stem Registry (21 Stems Exact) --------------------------------------------------------------


STEM_SPECS: list[StemSpec] = [
    # Flat-6 NA (992 GT3 RS)
    StemSpec(
        stem_id="eng_flat6_low",
        filename="eng_flat6_low.wav",
        category="engine",
        description="1800 RPM Flat-6 NA boxer growl & ITB induction loop (992 GT3 RS)",
        loop=True,
        duration_s=2.0,
        reference_rpm=1800,
        fundamental_hz=90.0,
        synth_fn=synth_eng_flat6_low,
    ),
    StemSpec(
        stem_id="eng_flat6_4000",
        filename="eng_flat6_4000.wav",
        category="engine",
        description="4000 RPM Flat-6 NA metallic titanium shriek loop (992 GT3 RS)",
        loop=True,
        duration_s=2.0,
        reference_rpm=4000,
        fundamental_hz=201.0,
        synth_fn=synth_eng_flat6_4000,
    ),
    # V12 NA (Daytona SP3 / Corsa)
    StemSpec(
        stem_id="eng_v12_low",
        filename="eng_v12_low.wav",
        category="engine",
        description="2000 RPM V12 NA silky exotic idle/burble loop (Daytona SP3 / Corsa)",
        loop=True,
        duration_s=2.0,
        reference_rpm=2000,
        fundamental_hz=198.0,
        synth_fn=synth_eng_v12_low,
    ),
    StemSpec(
        stem_id="eng_v12_5000",
        filename="eng_v12_5000.wav",
        category="engine",
        description="5000 RPM V12 NA piercing F1 soprano scream loop (Daytona SP3 / Corsa)",
        loop=True,
        duration_s=2.0,
        reference_rpm=5000,
        fundamental_hz=498.0,
        synth_fn=synth_eng_v12_5000,
    ),
    # V10 Screamer (Huracán / Fulmine)
    StemSpec(
        stem_id="eng_v10_low",
        filename="eng_v10_low.wav",
        category="engine",
        description="2000 RPM V10 odd-fire 54°/90° growl loop (Huracán / Fulmine)",
        loop=True,
        duration_s=2.0,
        reference_rpm=2000,
        fundamental_hz=165.0,
        synth_fn=synth_eng_v10_low,
    ),
    StemSpec(
        stem_id="eng_v10_5500",
        filename="eng_v10_5500.wav",
        category="engine",
        description="5500 RPM V10 odd-fire 54°/90° feral howl loop (Huracán / Fulmine)",
        loop=True,
        duration_s=2.0,
        reference_rpm=5500,
        fundamental_hz=460.0,
        synth_fn=synth_eng_v10_5500,
    ),
    # 4-Rotor Bridge-Port (RX-7 FD / 787B)
    StemSpec(
        stem_id="eng_rotary4_low",
        filename="eng_rotary4_low.wav",
        category="engine",
        description="1600 RPM 4-Rotor bridge-port chunky BRAP-BRAP idle overlap loop (RX-7 FD)",
        loop=True,
        duration_s=2.0,
        reference_rpm=1600,
        fundamental_hz=108.0,
        synth_fn=synth_eng_rotary4_low,
    ),
    StemSpec(
        stem_id="eng_rotary4_6000",
        filename="eng_rotary4_6000.wav",
        category="engine",
        description="6000 RPM 4-Rotor peripheral-port 787B razor-sharp shriek loop",
        loop=True,
        duration_s=2.0,
        reference_rpm=6000,
        fundamental_hz=400.0,
        synth_fn=synth_eng_rotary4_6000,
    ),
    # Forged Twin-Turbo I6 / V6 (Skyline R34 / NSX / Integrale)
    StemSpec(
        stem_id="eng_tt_i6_low",
        filename="eng_tt_i6_low.wav",
        category="engine",
        description="1800 RPM Forged Twin-Turbo I6 deep baritone rumble loop (Skyline R34 / 2JZ)",
        loop=True,
        duration_s=2.0,
        reference_rpm=1800,
        fundamental_hz=90.0,
        synth_fn=synth_eng_tt_i6_low,
    ),
    StemSpec(
        stem_id="eng_tt_i6_4000",
        filename="eng_tt_i6_4000.wav",
        category="engine",
        description="4000 RPM Forged Twin-Turbo I6 + dual-impeller turbo whistle loop",
        loop=True,
        duration_s=2.0,
        reference_rpm=4000,
        fundamental_hz=201.0,
        synth_fn=synth_eng_tt_i6_4000,
    ),
    # Cross-Plane V8 (Vela GT / Muscle)
    StemSpec(
        stem_id="eng_v8_cross_low",
        filename="eng_v8_cross_low.wav",
        category="engine",
        description="1500 RPM Cross-Plane V8 heavy unequal-bank American lope/burble loop",
        loop=True,
        duration_s=2.0,
        reference_rpm=1500,
        fundamental_hz=100.0,
        synth_fn=synth_eng_v8_cross_low,
    ),
    StemSpec(
        stem_id="eng_v8_cross_4200",
        filename="eng_v8_cross_4200.wav",
        category="engine",
        description="4200 RPM Cross-Plane V8 throaty unequal-bank roar loop (Vela GT / Muscle)",
        loop=True,
        duration_s=2.0,
        reference_rpm=4200,
        fundamental_hz=280.0,
        synth_fn=synth_eng_v8_cross_4200,
    ),
    # Flat-Plane V8 (Fiamma / GT3)
    StemSpec(
        stem_id="eng_v8_flat_low",
        filename="eng_v8_flat_low.wav",
        category="engine",
        description="2000 RPM Flat-Plane V8 crisp Italian growl loop (Fiamma / GT3)",
        loop=True,
        duration_s=2.0,
        reference_rpm=2000,
        fundamental_hz=132.0,
        synth_fn=synth_eng_v8_flat_low,
    ),
    StemSpec(
        stem_id="eng_v8_flat_5500",
        filename="eng_v8_flat_5500.wav",
        category="engine",
        description="5500 RPM Flat-Plane V8 high-revving Italian Inconel snarl loop (Fiamma / GT3)",
        loop=True,
        duration_s=2.0,
        reference_rpm=5500,
        fundamental_hz=368.0,
        synth_fn=synth_eng_v8_flat_5500,
    ),
    # Supercharged V8 (Hellhound)
    StemSpec(
        stem_id="eng_sc_v8_whine",
        filename="eng_sc_v8_whine.wav",
        category="engine",
        description="4000 RPM Supercharged cross-plane V8 roar + screaming Roots blower whine loop",
        loop=True,
        duration_s=2.0,
        reference_rpm=4000,
        fundamental_hz=268.0,
        synth_fn=synth_eng_sc_v8_whine,
    ),
    # Drivetrain, Induction & Exhaust FX
    StemSpec(
        stem_id="gear_whine_straightcut",
        filename="gear_whine_straightcut.wav",
        category="drivetrain_induction",
        description="Straight-cut sequential dog-box tooth-mesh whine loop (reference 1200 Hz mesh)",
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
        description="One-shot crisp 5-pulse compressor-surge blow-off valve flutter (stu-tu-tu-tu)",
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
        description="One-shot violent overrun shotgun exhaust crack + sub thump + titanium ring",
        loop=False,
        duration_s=0.55,
        reference_rpm=None,
        fundamental_hz=114.0,
        synth_fn=synth_exhaust_backfire_pop,
    ),
    # Tyre & Road Surface Loops
    StemSpec(
        stem_id="tyre_scrub_dry",
        filename="tyre_scrub_dry.wav",
        category="tyre_surface",
        description="Dry asphalt organic multi-band rubber stick-slip screech + 225 Hz cavity loop",
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
        description="Wet asphalt standing-water hydroplane spray hiss + wheel-arch droplet splash loop",
        loop=True,
        duration_s=2.0,
        reference_rpm=None,
        fundamental_hz=3600.0,
        synth_fn=synth_tyre_spray_wet,
    ),
    StemSpec(
        stem_id="kerb_rumble_strip",
        filename="kerb_rumble_strip.wav",
        category="tyre_surface",
        description="Track kerb rumble-strip 32 Hz hollow suspension thud + 225 Hz tyre cavity ring loop",
        loop=True,
        duration_s=2.0,
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


def generate_all(
    audio_dir: Path,
    manifest_path: Path,
    web_ogg_dir: Path | None,
) -> None:
    audio_dir.mkdir(parents=True, exist_ok=True)
    if web_ogg_dir is not None:
        web_ogg_dir.mkdir(parents=True, exist_ok=True)

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

        # Measure exact quantized 24-bit WAV file
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
        "schema_version": 2,
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
                # Validate OggS magic header
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
