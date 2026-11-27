// Lightweight entry gate: on phones, boots ONLY the ~15 KB Mobile Companion (zero WebGPU/WASM download, < 0.3s load).
// On Desktop, Tablets, automated tests (?menu=0), or when tapping "Launch WebGPU anyway", dynamically imports ./main.

function shouldShowMobileCompanion(): boolean {
  const q = new URLSearchParams(location.search);
  if (q.get('companion') === '1') return true;
  if (q.get('force_webgpu') === '1' || q.get('menu') === '0') return false;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const smallSide = Math.min(window.innerWidth, window.innerHeight) < 760;
  const mobileUa = /Android|iPhone|iPod|Mobile/i.test(navigator.userAgent);
  return (coarse && smallSide) || (mobileUa && smallSide);
}

const bootGame = () => {
  void import('./main');
};

if (shouldShowMobileCompanion()) {
  void import('./mobileCompanion').then(({ mountMobileCompanion }) => {
    mountMobileCompanion(bootGame);
  });
} else {
  bootGame();
}
