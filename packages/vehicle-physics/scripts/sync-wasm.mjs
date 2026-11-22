// Copy the WebAssembly build of the core from the game (web/src/physics) into dist/. The game and this package run
// the same binary; rebuild it with `bash web/wasm/build.sh` after changing core/ or web/wasm/bridge.cpp.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..', '..', '..', 'web', 'src', 'physics');
const dst = path.resolve(here, '..', 'dist');
fs.mkdirSync(dst, { recursive: true });
for (const f of ['rs_core.js', 'rs_core.wasm']) {
  const from = path.join(src, f);
  if (!fs.existsSync(from)) {
    console.error(`missing ${from}: build it with "bash web/wasm/build.sh" first`);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(dst, f));
}
console.log(`synced rs_core.js + rs_core.wasm (${(fs.statSync(path.join(dst, 'rs_core.wasm')).size / 1024).toFixed(0)} KB) into dist/`);
