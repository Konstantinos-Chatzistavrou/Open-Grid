#!/usr/bin/env bash
# Compiles ../core (C++17, no engine deps) + bridge.cpp to WebAssembly -> src/physics/rs_core.{js,wasm}
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
core="$here/../../core"
out="$here/../src/physics"
source "$HOME/emsdk/emsdk_env.sh" >/dev/null 2>&1

# The physics core's sources (CMake target rs_core); engine_audio.cpp is the separate engine-sim audio library.
srcs=()
for f in "$core"/src/*.cpp; do [ "$(basename "$f")" = engine_audio.cpp ] || srcs+=("$f"); done

em++ -std=c++17 -O3 -flto -fexceptions \
  -I"$core/include" -I"$core/third_party" \
  "${srcs[@]}" "$here/bridge.cpp" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createRsCore -sENVIRONMENT=web,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 \
  -sEXPORTED_FUNCTIONS=_rs_create,_rs_last_error,_rs_buffer,_rs_info,_rs_reset_motion,_rs_set_atmosphere,_rs_set_turbo_stage,_rs_rays,_rs_rays_patch,_rs_step,_rs_step_patch,_rs_contact,_rs_damage,_rs_repair,_rs_race_create,_rs_race_buffer,_rs_race_add,_rs_race_update,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPF64,stringToNewUTF8,UTF8ToString \
  -o "$out/rs_core.js"
echo "built $out/rs_core.js + rs_core.wasm"
