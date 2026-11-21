import { defineConfig, type Plugin } from 'vite';

// Dev only: the game POSTs its status line here every 2 s, printed in the dev-server log, so a
// session in any browser (including the user's own Chrome profile) can be checked from the terminal.
const telemetry: Plugin = {
  name: 'dev-telemetry',
  configureServer(server) {
    server.middlewares.use('/__telemetry', (req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', () => {
        console.log(`[game] ${new Date().toLocaleTimeString()} ${body.replace(/[^\x20-\x7e]/g, ' ').slice(0, 300)}`);
        res.statusCode = 204;
        res.end();
      });
    });
  },
};

// Cross-origin isolation enables SharedArrayBuffer + Atomics for the ?physworker=1 physics worker.
// COEP `credentialless` isolates Chrome/Firefox without breaking cross-origin embeds (Car Meet Spotify/YouTube
// iframes), PeerJS signaling, or bearer-token cloud API fetches. Set DISABLE_COOP_COEP=1 to opt out.
const isolationHeaders = process.env.DISABLE_COOP_COEP === '1' ? undefined : {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

// public/data is a symlink to ../data; public/assets holds the car and city glTF files.
export default defineConfig({
  plugins: [telemetry],
  server: { fs: { allow: ['..'] }, host: '127.0.0.1', port: 5173, headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: { target: 'es2022', assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
