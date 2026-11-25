#!/usr/bin/env bash
# Compiles OpenGrid's C++17 physical combustion & full-vehicle audio engine (vendored MIT engine-sim +
# core/src/engine_audio.cpp + core/include/rs/vehicle_audio.hpp + web/wasm/audio_bridge.cpp) to
# WebAssembly AudioWorklet assets -> web/public/audio/rs_audio.wasm + opengrid-audio-worklet.js
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
core="$here/../../core"
es="$core/third_party/engine_sim"
out="$here/../public/audio"
mkdir -p "$out"
source "$HOME/emsdk/emsdk_env.sh" >/dev/null 2>&1

srcs=(
  "$core/src/engine_audio.cpp"
  "$core/src/tire.cpp"
  "$core/src/config.cpp"
  "$core/src/kinematics.cpp"
  "$here/audio_bridge.cpp"
)
for f in "$es"/src/*.cpp "$es"/scs/src/*.cpp "$es"/csv_io/src/*.cpp; do
  srcs+=("$f")
done

tmp_js="$out/_rs_audio_core.js"
em++ -std=c++17 -O3 -flto -fexceptions -D__forceinline=inline -include cstdlib -w \
  -I"$core/include" -I"$core/third_party" \
  -I"$es/include" -I"$es/scs/include" -I"$es/csv_io/include" \
  "${srcs[@]}" \
  -sMODULARIZE=1 -sEXPORT_NAME=createRsAudio -sENVIRONMENT=shell \
  -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=33554432 \
  -sEXPORTED_FUNCTIONS=_rsa_init,_rsa_set_voice,_rsa_telemetry_ptr,_rsa_apply_telemetry,_rsa_out_l_ptr,_rsa_out_r_ptr,_rsa_render,_rsa_trigger_pop,_rsa_trigger_flutter,_rsa_trigger_crank,_rsa_trigger_burble,_rsa_trigger_impact,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPF32 \
  -o "$tmp_js"

mv "$out/_rs_audio_core.wasm" "$out/rs_audio.wasm"
# Patch Emscripten's internal default wasm filename reference (wasmBinary is passed directly in worklet)
sed -i 's/_rs_audio_core\.wasm/rs_audio.wasm/g' "$tmp_js"
# Bundle single self-contained AudioWorklet script (zero imports, zero fetch inside AudioWorkletGlobalScope!)
cat "$tmp_js" "$here/rs_audio_worklet_body.js" > "$out/opengrid-audio-worklet.js"
# Also keep an ES-exportable helper copy for Node verification scripts (gitignored or kept in wasm/)
rm -f "$tmp_js"

ls -lh "$out/rs_audio.wasm" "$out/opengrid-audio-worklet.js"
echo "built $out/rs_audio.wasm + $out/opengrid-audio-worklet.js"
