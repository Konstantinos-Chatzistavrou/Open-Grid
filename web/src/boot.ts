// Entry gate. Every device boots the game: phones and tablets take the lighter "touch" path inside main.ts (medium
// preset, 30 fps cap, shorter streaming distance, touch controls), desktops and laptops take the full path.
// The small landing / companion page (leaderboards, profile) is opt-in only: open /?companion=1.

function wantsCompanionPage(): boolean {
  return new URLSearchParams(location.search).get('companion') === '1';
}

const bootGame = () => {
  void import('./main');
};

if (wantsCompanionPage()) {
  void import('./mobileCompanion').then(({ mountMobileCompanion }) => {
    mountMobileCompanion(bootGame);
  });
} else {
  bootGame();
}
