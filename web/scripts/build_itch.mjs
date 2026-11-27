// Builds an itch.io-compliant HTML5 ZIP (<= 1,000 files, <= 500 MB extracted, <= 200 MB per file,
// index.html at root, relative paths) into ../dist/itch/open-grid-itch-html5.zip.
// Heavy streaming city tile directories (assets/cities, assets/nyc: ~1.26 GB / ~27k tiles) are
// excluded from the ZIP and fetched over CORS from VITE_CITY_CDN (default: https://open-grid.racing).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(webDir, '..');
const outDir = path.join(repoRoot, 'dist', 'itch');
const zipPath = path.join(outDir, 'open-grid-itch-html5.zip');
const cityCdn = (process.env.VITE_CITY_CDN ?? 'https://open-grid.racing').replace(/\/+$/, '');

const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengrid-itch-'));
const env = { ...process.env, VITE_ITCH_BUILD: '1', VITE_CITY_CDN: cityCdn };

try {
  console.log(`[itch] typecheck + vite build (base: ./, city CDN: ${cityCdn})...`);
  execFileSync('npx', ['tsc', '--noEmit'], { cwd: webDir, env, stdio: 'inherit' });
  execFileSync('npx', ['vite', 'build', '--outDir', stageDir, '--emptyOutDir'], {
    cwd: webDir,
    env,
    stdio: 'inherit',
  });

  // Remove directories streamed over CORS from open-grid.racing or offline C++/UE5 datasets.
  const pruneDirs = [
    'assets/cities',
    'assets/nyc',
    'data/physics',
    'data/validation',
    'data/reference',
    'data/ue5',
    'data/powertrain',
    'data/schema',
    'lab',
    'registry',
  ];
  for (const rel of pruneDirs) {
    fs.rmSync(path.join(stageDir, rel), { recursive: true, force: true });
  }

  // Audit itch.io HTML5 ZIP constraints.
  let fileCount = 0;
  let totalBytes = 0;
  let maxFileBytes = 0;
  let maxFilePath = '';
  let maxPathLen = 0;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        fileCount++;
        const st = fs.statSync(full);
        totalBytes += st.size;
        if (st.size > maxFileBytes) {
          maxFileBytes = st.size;
          maxFilePath = path.relative(stageDir, full);
        }
        const relLen = path.relative(stageDir, full).length;
        if (relLen > maxPathLen) maxPathLen = relLen;
      }
    }
  }
  walk(stageDir);

  if (!fs.existsSync(path.join(stageDir, 'index.html'))) {
    throw new Error('Missing index.html at ZIP root');
  }
  const mb = (b) => (b / (1024 * 1024)).toFixed(1);
  console.log(`[itch] extracted files: ${fileCount} / 1000 max`);
  console.log(`[itch] extracted size : ${mb(totalBytes)} MB / 500 MB max`);
  console.log(`[itch] largest file   : ${mb(maxFileBytes)} MB (${maxFilePath}) / 200 MB max`);
  console.log(`[itch] longest path   : ${maxPathLen} chars / 240 max`);

  if (fileCount > 1000) throw new Error(`File count ${fileCount} exceeds itch.io limit of 1000`);
  if (totalBytes > 500 * 1024 * 1024) throw new Error(`Extracted size ${mb(totalBytes)} MB exceeds itch.io 500 MB limit`);
  if (maxFileBytes > 200 * 1024 * 1024) throw new Error(`Largest file ${maxFilePath} exceeds itch.io 200 MB limit`);
  if (maxPathLen > 240) throw new Error(`Path length ${maxPathLen} exceeds itch.io 240-char limit`);

  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(zipPath, { force: true });
  console.log(`[itch] zipping -> ${zipPath}`);
  execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: stageDir, stdio: 'inherit' });
  const zipSize = fs.statSync(zipPath).size;
  console.log(`[itch] OK: ${zipPath} (${mb(zipSize)} MB compressed)`);
} finally {
  if (process.env.KEEP_STAGE === '1') {
    console.log(`[itch] kept stage dir: ${stageDir}`);
  } else {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}
