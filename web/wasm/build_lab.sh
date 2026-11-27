#!/usr/bin/env bash
# Compiles rs::mf62 + rs::tirfit + tyrelab_bridge.cpp to WebAssembly for the Tyre Lab page -> ../public/lab/tyrelab.{js,wasm}
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
core="$here/../../core"
out="$here/../public/lab"
source "$HOME/emsdk/emsdk_env.sh" >/dev/null 2>&1
mkdir -p "$out"
em++ -std=c++20 -O2 -fexceptions \
  -I"$core/include" -I"$core/third_party" \
  "$core/src/mf62.cpp" "$core/tools/tirfit.cpp" "$here/tyrelab_bridge.cpp" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createTyreLab -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 \
  -sEXPORTED_FUNCTIONS=_lab_fit,_lab_demo,_lab_rows,_lab_tyre_info,_lab_curve,_lab_curve_ptr,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPF64,stringToNewUTF8,UTF8ToString \
  -o "$out/tyrelab.js"
echo "built $out/tyrelab.js + tyrelab.wasm"
