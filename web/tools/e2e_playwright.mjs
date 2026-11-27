// Apache-2.0 — End-to-end Playwright WebGPU test suite for OpenGrid (Desktop + Mobile Landscape + Mobile Portrait).
// Serves web/dist on an ephemeral localhost port, launches headless Chrome/Chromium with WebGPU enabled,
// drives the real car with real inputs, verifies zero runtime/network errors, checks clutch/gearbox/handling
// invariants, checks WASM AudioWorklet loading, and measures GPS minimap bezel thickness across viewports.
//
// Usage:
//   npm --prefix web run test:e2e
//   E2E_SHOT_DIR=/tmp/shots node web/tools/e2e_playwright.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, '..');
const distDir = path.join(webDir, 'dist');
const shotDir = process.env.E2E_SHOT_DIR ? path.resolve(process.env.E2E_SHOT_DIR) : null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
};

function startStaticServer(root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const full = path.resolve(root, rel);
      if (!full.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
      fs.stat(full, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
        const ext = path.extname(full).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        fs.createReadStream(full).pipe(res);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

let failures = 0;
function check(label, ok, detail = '') {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function waitGameReady(page, timeoutMs = 90000) {
  await page.waitForFunction(
    () => Boolean(window.__game) && !document.getElementById('loading'),
    { timeout: timeoutMs },
  );
  // A new device meets the welcome gate (guest / log in / sign up) before the title: play as a guest
  const guest = page.locator('[data-act="gate-guest"]');
  if (await guest.isVisible().catch(() => false)) {
    await guest.click();
    await page.waitForTimeout(400);
  }
  // Dismiss first-run username modal if present on production build
  const uname = page.locator('#uname');
  if (await uname.isVisible().catch(() => false)) {
    await uname.fill('E2ETestDriver');
    const saveBtn = page.locator('#menu button').filter({ hasText: /continue|save|start|ok/i }).first();
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(400);
    }
  }
}

async function measureMinimapBezel(page) {
  return page.evaluate(() => {
    const wrap = document.getElementById('minimap');
    const cv = wrap?.querySelector('canvas');
    const chin = wrap?.querySelector('.gps-chin');
    if (!wrap || !cv) return null;
    const wr = wrap.getBoundingClientRect();
    const cr = cv.getBoundingClientRect();
    const chr = chin ? chin.getBoundingClientRect() : null;
    return {
      visible: !wrap.hidden && wr.width > 0 && wr.height > 0,
      expanded: wrap.classList.contains('expanded'),
      wrapW: +wr.width.toFixed(1),
      wrapH: +wr.height.toFixed(1),
      canvasW: +cr.width.toFixed(1),
      canvasH: +cr.height.toFixed(1),
      aspect: +(cr.width / Math.max(1, cr.height)).toFixed(3),
      bezelTop: +(cr.top - wr.top).toFixed(1),
      bezelLeft: +(cr.left - wr.left).toFixed(1),
      bezelRight: +(wr.right - cr.right).toFixed(1),
      bezelBottom: +(wr.bottom - cr.bottom).toFixed(1),
      chinH: chr ? +chr.height.toFixed(1) : 0,
      vw: window.innerWidth,
      vh: window.innerHeight,
      inViewport: wr.left >= -1 && wr.top >= -1 && wr.right <= window.innerWidth + 1 && wr.bottom <= window.innerHeight + 1,
    };
  });
}

async function main() {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.error('web/dist/index.html missing — run `npm --prefix web run build` first.');
    process.exit(1);
  }
  if (shotDir) fs.mkdirSync(shotDir, { recursive: true });

  const { server, port } = await startStaticServer(distDir);
  const baseUrl = `http://127.0.0.1:${port}`;
  const chromePath = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find((p) => fs.existsSync(p));

  const browser = await chromium.launch({
    ...(chromePath ? { executablePath: chromePath } : {}),
    headless: true,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-angle=vulkan',
      '--ignore-gpu-blocklist',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--no-sandbox',
    ],
  });

  try {
    // =========================================================================
    // 1. DESKTOP E2E (1280x720): boot, assets, WASM audio, driving, steering, GPS bezel
    // =========================================================================
    console.log('\n== E2E Desktop (1280x720) ==');
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await ctx.newPage();
      const pageErrors = [];
      const failedLocal = [];
      let sawAudioWasm = false;
      let sawAudioWorklet = false;

      page.on('pageerror', (e) => pageErrors.push(String(e)));
      page.on('response', (res) => {
        const u = res.url();
        if (u.startsWith(baseUrl)) {
          if (u.includes('/audio/rs_audio.wasm') && res.status() === 200) sawAudioWasm = true;
          if (u.includes('/audio/opengrid-audio-worklet.js') && res.status() === 200) sawAudioWorklet = true;
          const rel = u.replace(baseUrl, '');
          // Ignore intentional optional discovery probes (extra cities, optional bodykit variant GLBs, favicon)
          const isOptionalProbe = rel.includes('favicon') || rel.endsWith('/extra.json') || /\/cars\/v3\/[a-z0-9_]+_(front|rear|hood|skirt|wing)/.test(rel);
          if (res.status() >= 400 && !isOptionalProbe) {
            failedLocal.push(`${res.status()} ${rel}`);
          }
        }
      });

      await page.goto(`${baseUrl}/?menu=0&touch=0&weather=dry&gps=night`, { waitUntil: 'domcontentloaded' });
      await waitGameReady(page);
      await page.waitForTimeout(1200);

      // Click canvas once to unlock audio context and give WASM AudioWorklet time to report ready
      await page.mouse.click(640, 360);
      await page.waitForFunction(() => window.__game?.audio?.wasmPhysicalAudioActive === true, { timeout: 5000 }).catch(() => {});

      // Verify state is live driving and zero errors
      const bootInfo = await page.evaluate(() => {
        const g = window.__game;
        return {
          state: g.state,
          weather: g.worldClock?.weather,
          wetness: g.worldClock?.wetness,
          wasmAudioActive: g.audio?.wasmPhysicalAudioActive ?? false,
          wasmAudioError: g.audio?.wasmAudioError ?? '',
          lowPower: g.audio?.lowPower ?? false,
        };
      });
      check('desktop boots cleanly into live driving', bootInfo.state === 'race', `state=${bootInfo.state}`);
      check('zero uncaught page errors on desktop boot', pageErrors.length === 0, pageErrors.join('; '));
      check('zero 4xx/5xx required local asset fetches', failedLocal.length === 0, failedLocal.slice(0, 5).join(', '));
      check('WASM AudioWorklet active in live browser AudioWorkletGlobalScope', sawAudioWasm && bootInfo.wasmAudioActive,
        `wasm=${sawAudioWasm} worklet=${sawAudioWorklet} active=${bootInfo.wasmAudioActive} err=${bootInfo.wasmAudioError || 'none'}`);

      // Measure desktop minimap bezel
      const mmDesk = await measureMinimapBezel(page);
      check('desktop GPS bezel is slim & uniform (~6 px sides/top, <=16 px chin)',
        Boolean(mmDesk && mmDesk.visible && mmDesk.bezelTop <= 7 && mmDesk.bezelLeft <= 7 && mmDesk.bezelRight <= 7 && mmDesk.bezelBottom <= 16 && Math.abs(mmDesk.aspect - 1.6) < 0.08),
        JSON.stringify(mmDesk));

      // Straight-line full-throttle acceleration (4.2 s)
      await page.keyboard.down('KeyW');
      await page.waitForTimeout(4200);
      const accelSample = await page.evaluate(() => {
        const g = window.__game;
        const o = g.car.out;
        return {
          speedKmh: +(Math.abs(o[102]) * 3.6).toFixed(1),
          rpm: Math.round(o[103]),
          gear: Math.round(o[104]),
          stalled: o[106] > 0.5,
          clutchTemp: +(o[275] || 40).toFixed(1),
          clutchHealth: +(o[276] || 1).toFixed(3),
          gbHealth: +(o[277] || 1).toFixed(3),
          missedShifts: Math.round(o[278] || 0),
          finite: Number.isFinite(o[102]) && Number.isFinite(o[103]),
        };
      });
      await page.keyboard.up('KeyW');
      check('straight acceleration builds clean speed (> 55 km/h in 4.2 s, finite, not stalled)',
        accelSample.finite && !accelSample.stalled && accelSample.speedKmh > 55,
        JSON.stringify(accelSample));
      check('no clutch meltdown or missed shifts during full-throttle acceleration',
        accelSample.clutchHealth >= 0.95 && accelSample.clutchTemp < 180 && accelSample.missedShifts === 0,
        `temp=${accelSample.clutchTemp}C health=${accelSample.clutchHealth} missed=${accelSample.missedShifts}`);

      if (shotDir) await page.screenshot({ path: path.join(shotDir, 'e2e_desktop_drive.png') });

      // Brake briefly then test full-steer + throttle (W + A) from slow speed
      await page.keyboard.down('KeyS');
      await page.waitForTimeout(1800);
      await page.keyboard.up('KeyS');
      await page.keyboard.down('KeyW');
      await page.keyboard.down('KeyA');
      let maxTurnKmh = 0;
      for (let i = 0; i < 16; i++) {
        await page.waitForTimeout(250);
        const kmh = await page.evaluate(() => Math.abs(window.__game.car.out[102]) * 3.6);
        if (kmh > maxTurnKmh) maxTurnKmh = kmh;
      }
      await page.keyboard.up('KeyA');
      await page.keyboard.up('KeyW');
      check('full-steer + throttle (W+A) clears 30 km/h cleanly (no ESC/TC deadlock)',
        maxTurnKmh > 30, `maxTurnKmh=${maxTurnKmh.toFixed(1)} km/h`);

      // Toggle expanded full GPS map (Tab) and verify bezel & viewport bounds
      await page.keyboard.press('Tab');
      await page.waitForTimeout(450);
      const mmExp = await measureMinimapBezel(page);
      check('desktop expanded GPS map stays inside viewport with uniform 6 px bezel',
        Boolean(mmExp && mmExp.expanded && mmExp.inViewport && mmExp.bezelTop <= 7 && mmExp.bezelLeft <= 7 && mmExp.bezelBottom <= 16),
        JSON.stringify(mmExp));
      if (shotDir) await page.screenshot({ path: path.join(shotDir, 'e2e_desktop_map_expanded.png') });
      await page.keyboard.press('Tab');

      check('zero page errors throughout desktop drive session', pageErrors.length === 0, pageErrors.join('; '));
      await ctx.close();
    }

    // =========================================================================
    // 2. MOBILE LANDSCAPE E2E (844x390, touch): bezel parity + touch controls
    // =========================================================================
    console.log('\n== E2E Mobile Landscape (844x390, touch) ==');
    {
      const ctx = await browser.newContext({
        viewport: { width: 844, height: 390 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));

      await page.goto(`${baseUrl}/?menu=0&touch=1&weather=dry&gps=night`, { waitUntil: 'domcontentloaded' });
      await waitGameReady(page);
      await page.waitForTimeout(900);

      const hasTouchClass = await page.evaluate(() => document.body.classList.contains('touch'));
      const mmMobLand = await measureMinimapBezel(page);
      check('mobile landscape activates body.touch layout', hasTouchClass);
      check('mobile landscape GPS bezel matches desktop thickness (~6 px sides/top, <=14 px chin, NO 55px chin bug!)',
        Boolean(mmMobLand && mmMobLand.visible && mmMobLand.inViewport && mmMobLand.bezelTop <= 7 && mmMobLand.bezelLeft <= 7 && mmMobLand.bezelRight <= 7 && mmMobLand.bezelBottom <= 14 && Math.abs(mmMobLand.aspect - 1.6) < 0.08),
        JSON.stringify(mmMobLand));
      if (shotDir) await page.screenshot({ path: path.join(shotDir, 'e2e_mobile_landscape.png') });

      // Tap minimap to expand on mobile landscape
      await page.locator('#minimap canvas').tap();
      await page.waitForTimeout(450);
      const mmMobExp = await measureMinimapBezel(page);
      check('mobile landscape expanded GPS fits viewport with uniform 6 px bezel',
        Boolean(mmMobExp && mmMobExp.expanded && mmMobExp.inViewport && mmMobExp.bezelTop <= 7 && mmMobExp.bezelBottom <= 14),
        JSON.stringify(mmMobExp));
      check('zero page errors on mobile landscape', pageErrors.length === 0, pageErrors.join('; '));
      await ctx.close();
    }

    // =========================================================================
    // 3. MOBILE PORTRAIT E2E (390x844, touch): bezel parity + viewport fit
    // =========================================================================
    console.log('\n== E2E Mobile Portrait (390x844, touch) ==');
    {
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));

      await page.goto(`${baseUrl}/?menu=0&touch=1&weather=dry&gps=night`, { waitUntil: 'domcontentloaded' });
      await waitGameReady(page);
      await page.waitForTimeout(900);

      const mmMobPort = await measureMinimapBezel(page);
      check('mobile portrait GPS bezel matches desktop thickness (~6 px sides/top, <=14 px chin)',
        Boolean(mmMobPort && mmMobPort.visible && mmMobPort.inViewport && mmMobPort.bezelTop <= 7 && mmMobPort.bezelLeft <= 7 && mmMobPort.bezelRight <= 7 && mmMobPort.bezelBottom <= 14 && Math.abs(mmMobPort.aspect - 1.6) < 0.08),
        JSON.stringify(mmMobPort));
      if (shotDir) await page.screenshot({ path: path.join(shotDir, 'e2e_mobile_portrait.png') });
      check('zero page errors on mobile portrait', pageErrors.length === 0, pageErrors.join('; '));
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\nE2E finished with ${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
