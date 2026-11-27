#!/usr/bin/env python3
# Apache-2.0 — Reproducible neural radio voice generator for OpenGrid.
# Uses open-source Piper TTS (MIT licence, HuggingFace rhasspy/piper-voices)
# + ffmpeg Motorola APX VHF / Underground CB radio DSP chain to build compact
# studio-realistic .ogg (Opus 24 kbps mono 24 kHz) voice clips.

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import tempfile
import urllib.request
import wave
from pathlib import Path

HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"

VOICE_MODELS: dict[str, tuple[str, str]] = {
    "dispatch": (
        "en_US-lessac-high",
        f"{HF_BASE}/en/en_US/lessac/high/en_US-lessac-high",
    ),
    "unit": (
        "en_US-ryan-high",
        f"{HF_BASE}/en/en_US/ryan/high/en_US-ryan-high",
    ),
    "street": (
        "en_US-joe-medium",
        f"{HF_BASE}/en/en_US/joe/medium/en_US-joe-medium",
    ),
}

# (clip_id, voice_key, dsp_profile, spoken_text)
CLIPS: list[tuple[str, str, str, str]] = [
    # Police Dispatch (DISPATCH — calm, crisp female dispatcher)
    (
        "cam_dispatch",
        "dispatch",
        "police",
        "All units, speed cam just tripped — high-speed suspect northbound. Interceptor squad, move in.",
    ),
    (
        "cam_respot",
        "dispatch",
        "police",
        "Dispatch to all units, camera just caught the suspect again. Re-engage pursuit, over.",
    ),
    (
        "roadblock_deploy",
        "dispatch",
        "police",
        "All units, roadblock going up two hundred meters ahead of the suspect. Lock down the avenue.",
    ),
    (
        "escaped",
        "dispatch",
        "police",
        "Ten-twenty-two, cancel pursuit. Suspect slipped the net — all units return to patrol.",
    ),
    # Police Interceptor Officers (UNIT-04 / UNIT-07 — deep authoritative male voice)
    (
        "patrol_spotted",
        "unit",
        "police",
        "Dispatch, Unit Four — I've got a reckless street racer flying past me. Lights and sirens, I'm on them.",
    ),
    (
        "unit_visual",
        "unit",
        "police",
        "Ten-four Dispatch, Unit Four has visual. Closing fast, lights and sirens.",
    ),
    (
        "intercept_ahead",
        "unit",
        "police",
        "Unit Seven rolling out ahead of the suspect. Moving to cut them off at the intersection.",
    ),
    (
        "pit_request",
        "unit",
        "police",
        "Unit Four, I'm on the rear quarter — moving in for a pit maneuver.",
    ),
    (
        "pit_contact",
        "unit",
        "police",
        "Contact! Pit engaged, keep them boxed in!",
    ),
    (
        "roadblock_cleared",
        "unit",
        "police",
        "Suspect blew right through the roadblock! Staying on their tail!",
    ),
    (
        "high_speed",
        "unit",
        "police",
        "Suspect is pulling hard on the straight — requesting high-speed backup!",
    ),
    (
        "evading_gap",
        "unit",
        "police",
        "Unit Four, suspect's opening a gap. Switching to search pattern.",
    ),
    (
        "evading_los",
        "unit",
        "police",
        "Lost visual behind the downtown blocks. Sweeping the side streets.",
    ),
    (
        "reacquired",
        "unit",
        "police",
        "Got them! Visual re-acquired, back in hot pursuit!",
    ),
    (
        "busted",
        "unit",
        "police",
        "Suspect vehicle is boxed in and stopped. Driver in custody, ten-fifteen.",
    ),
    # Underground Street Crew / GPS (street radio — natural urgent racer voice)
    (
        "street_cam_warn",
        "street",
        "street",
        "Heads up! Somebody just tripped the speed camera — police scanners are lighting up!",
    ),
    (
        "street_rb_punch",
        "street",
        "street",
        "Yo, cops threw up a roadblock right ahead! Front pack, punch through the gap!",
    ),
    (
        "street_rb_forming",
        "street",
        "street",
        "Watch out, police roadblock forming ahead — GPS is rerouting us around the block!",
    ),
    (
        "street_rb_reroute",
        "street",
        "street",
        "Bypass route locked on GPS — swing wide around the cruisers!",
    ),
    (
        "street_rb_cleared",
        "street",
        "street",
        "Clean! We're past the roadblock — back on the main line, floor it!",
    ),
]

VOICE_PACING: dict[str, dict[str, float]] = {
    "dispatch": {"length_scale": 0.81, "noise_scale": 0.62, "noise_w_scale": 0.78},
    "unit": {"length_scale": 0.90, "noise_scale": 0.66, "noise_w_scale": 0.80},
    "street": {"length_scale": 0.91, "noise_scale": 0.68, "noise_w_scale": 0.82},
}


def find_bin(name: str) -> str:
    hit = shutil.which(name)
    if hit:
        return hit
    local = Path.home() / ".local" / "bin" / name
    if local.is_file():
        return str(local)
    raise FileNotFoundError(f"Required binary '{name}' not found in PATH or ~/.local/bin")


def ensure_models(models_dir: Path) -> dict[str, Path]:
    models_dir.mkdir(parents=True, exist_ok=True)
    resolved: dict[str, Path] = {}
    for key, (stem, url_base) in VOICE_MODELS.items():
        onnx_path = models_dir / f"{stem}.onnx"
        json_path = models_dir / f"{stem}.onnx.json"
        for path, url in ((onnx_path, f"{url_base}.onnx"), (json_path, f"{url_base}.onnx.json")):
            if not path.is_file() or path.stat().st_size == 0:
                print(f"[download] {url} -> {path}")
                urllib.request.urlretrieve(url, path)
        resolved[key] = onnx_path
    return resolved


def build_syn_config(voice_key: str):
    from piper.config import SynthesisConfig

    params = VOICE_PACING[voice_key]
    kwargs = {}
    fields = getattr(SynthesisConfig, "__dataclass_fields__", {})
    for k, v in params.items():
        if k in fields:
            kwargs[k] = v
    return SynthesisConfig(**kwargs)


def process_radio_dsp(ffmpeg_bin: str, raw_wav: Path, out_ogg: Path, profile: str) -> None:
    trim = (
        "silenceremove=start_periods=1:start_silence=0.02:start_threshold=-45dB,"
        "areverse,"
        "silenceremove=start_periods=1:start_silence=0.06:start_threshold=-45dB,"
        "areverse"
    )
    if profile == "police":
        # Authentic Motorola APX / VHF police scanner bandwidth + presence + hard radio compression + subtle carrier bed
        voice_chain = (
            f"{trim},"
            "highpass=f=340,lowpass=f=3000,"
            "equalizer=f=1500:t=q:w=1.3:g=4.5,"
            "acompressor=threshold=-22dB:ratio=6:attack=3:release=55:makeup=11dB,"
            "alimiter=limit=0.9"
        )
        noise_chain = "anoisesrc=color=white:r=24000:a=1.0,highpass=f=500,lowpass=f=2800,volume=-32dB"
    else:
        # Slightly warmer underground CB / walkie-talkie EQ + compression + subtle CB static bed
        voice_chain = (
            f"{trim},"
            "highpass=f=280,lowpass=f=3400,"
            "equalizer=f=1350:t=q:w=1.1:g=2.5,"
            "acompressor=threshold=-20dB:ratio=4.5:attack=4:release=60:makeup=9dB,"
            "alimiter=limit=0.9"
        )
        noise_chain = "anoisesrc=color=pink:r=24000:a=1.0,highpass=f=350,lowpass=f=3200,volume=-33dB"

    filter_complex = (
        f"[0:a]aresample=24000,{voice_chain}[v];"
        f"{noise_chain}[n];"
        "[v][n]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,"
        "afade=t=in:d=0.012,alimiter=limit=0.92[out]"
    )

    cmd = [
        ffmpeg_bin,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(raw_wav),
        "-filter_complex",
        filter_complex,
        "-map",
        "[out]",
        "-ac",
        "1",
        "-ar",
        "24000",
        "-c:a",
        "libopus",
        "-b:a",
        "24k",
        "-vbr",
        "on",
        "-application",
        "voip",
        str(out_ogg),
    ]
    subprocess.run(cmd, check=True)


def probe_duration(ffprobe_bin: str, path: Path) -> float:
    out = subprocess.check_output(
        [
            ffprobe_bin,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        text=True,
    ).strip()
    return float(out)


def main() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="Generate neural radio voice .ogg clips via Piper TTS + ffmpeg.")
    parser.add_argument(
        "--models-dir",
        type=Path,
        default=Path(os.environ.get("PIPER_MODELS_DIR", "/tmp/piper_models")),
        help="Directory holding Piper .onnx + .onnx.json models (auto-downloaded if missing).",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=repo_root / "web" / "public" / "assets" / "audio" / "radio",
        help="Destination folder for generated .ogg voice clips.",
    )
    args = parser.parse_args()

    ffmpeg_bin = find_bin("ffmpeg")
    ffprobe_bin = find_bin("ffprobe")
    model_paths = ensure_models(args.models_dir)
    args.out_dir.mkdir(parents=True, exist_ok=True)

    from piper.voice import PiperVoice

    voices: dict[str, PiperVoice] = {}
    for key, path in model_paths.items():
        print(f"[load] {key}: {path.name}")
        voices[key] = PiperVoice.load(str(path))

    total_bytes = 0
    with tempfile.TemporaryDirectory(prefix="opengrid_radio_") as tmpdir:
        tmp = Path(tmpdir)
        for clip_id, voice_key, profile, text in CLIPS:
            raw_wav = tmp / f"{clip_id}.wav"
            out_ogg = args.out_dir / f"{clip_id}.ogg"
            syn_cfg = build_syn_config(voice_key)
            with wave.open(str(raw_wav), "wb") as wf:
                voices[voice_key].synthesize_wav(text, wf, syn_config=syn_cfg)
            process_radio_dsp(ffmpeg_bin, raw_wav, out_ogg, profile)
            dur = probe_duration(ffprobe_bin, out_ogg)
            sz = out_ogg.stat().st_size
            total_bytes += sz
            print(f"  [ok] {clip_id:20s} ({voice_key:8s}/{profile:6s})  {dur:4.2f}s  {sz / 1024:5.1f} KB")

    print(f"\nGenerated {len(CLIPS)} clips in {args.out_dir} — total {total_bytes / 1024:.1f} KB ({total_bytes} bytes)")


if __name__ == "__main__":
    main()
