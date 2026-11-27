// Apache-2.0 — Ultra-Fast Mobile Landing & Live Companion App for Open Grid (open-grid.racing).
// Loads in < 0.3s on phones WITHOUT downloading Three.js, Rapier, WASM, or city tiles (~15 KB vs ~8 MB).
// Gives mobile visitors a sharp #0A0A0A / #FF1111 motorsport landing page plus live Cloudflare D1
// Profile (DR/SR/License), Global Hotlaps, and Official Split Schedule, with a discreet opt-in to launch WebGPU.
import { Cloud, type OAuthProvider, type OAuthProvidersStatus, type OfficialSeriesEvent, type Profile } from './cloud';

type TabId = 'overview' | 'hotlaps' | 'schedule' | 'profile';

const TRACK_OPTIONS: [string, string][] = [
  ['nyc', 'New York'],
  ['london', 'London'],
  ['tokyo', 'Tokyo'],
  ['paris', 'Paris'],
  ['singapore', 'Singapore'],
  ['losangeles', 'Los Angeles'],
  ['chicago', 'Chicago'],
  ['madrid', 'Madrid'],
  ['berlin', 'Berlin'],
  ['miami', 'Miami'],
];

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function fmtLapMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalSec = ms / 1000;
  const mins = Math.floor(totalSec / 60);
  const secs = (totalSec % 60).toFixed(3).padStart(6, '0');
  return `${mins}:${secs}`;
}

export function mountMobileCompanion(onLaunchAnyway: () => void) {
  document.getElementById('enter')?.remove();
  const loading = document.getElementById('loading');
  if (loading) loading.hidden = true;
  document.body.classList.add('mobile-companion-mode');

  const root = document.getElementById('mobile-companion') ?? (() => {
    const d = document.createElement('div');
    d.id = 'mobile-companion';
    document.body.appendChild(d);
    return d;
  })();
  root.hidden = false;

  const cloud = new Cloud();
  const params = new URLSearchParams(location.search);
  const inviteParty = params.get('party');
  const inviteGarage = params.get('garage');

  let tab: TabId = cloud.oauthSignedInProvider ? 'profile' : 'overview';
  let track = 'nyc';
  let copyStatus = '';
  let oauthProviders: OAuthProvidersStatus = { google: false, github: false, discord: false };
  let hotlaps: { username: string; car: string; lap_ms: number }[] | null = null;
  let hotlapErr = '';
  let schedule: OfficialSeriesEvent[] | null = null;
  let scheduleErr = '';
  let profile: Profile | null = null;
  let authMsg = cloud.oauthSignedInProvider
    ? `✓ Signed in with ${cloud.oauthSignedInProvider[0].toUpperCase() + cloud.oauthSignedInProvider.slice(1)}!`
    : '';
  let authBusy = false;

  const fetchHotlaps = async () => {
    hotlaps = null; hotlapErr = ''; render();
    if (!cloud.available) { hotlapErr = 'Online service offline.'; render(); return; }
    try {
      const r = await cloud.leaderboards(track, '', 'dry');
      hotlaps = r.entries ?? [];
    } catch (e) {
      hotlapErr = e instanceof Error ? e.message : 'Could not load hotlaps.';
    }
    render();
  };

  const fetchSchedule = async () => {
    schedule = null; scheduleErr = ''; render();
    if (!cloud.available) { scheduleErr = 'Online service offline.'; render(); return; }
    try {
      const r = await cloud.schedule();
      schedule = r.events ?? [];
    } catch (e) {
      scheduleErr = e instanceof Error ? e.message : 'Could not load schedule.';
    }
    render();
  };

  const loadAccountIfSignedIn = async () => {
    if (!cloud.available) return;
    void cloud.authProviders().then((p) => { oauthProviders = p; render(); }).catch(() => {});
    if (!cloud.id) return;
    try {
      profile = await cloud.me();
      render();
    } catch { /* guest or expired */ }
  };

  const renderOverview = () => `
    <div class="mc-cards">
      <div class="mc-card"><span class="mc-k">01 · PHYSICS</span><b>240 Hz C++20 Sim Core</b><p>Pacejka MF 5.2/6.1 tyres with 3-zone thermals, 3D suspension kinematics, active aero &amp; WebHID wheel force feedback.</p></div>
      <div class="mc-card"><span class="mc-k">02 · WORLD</span><b>18 Real-Scale 1:1 Cities</b><p>New York, Tokyo, London, Paris, Singapore, Chicago, Madrid, Crete Imbros Pass &amp; more — zero U-turn street circuits.</p></div>
      <div class="mc-card"><span class="mc-k">03 · ONLINE</span><b>Free Community Splits &amp; DR/SR</b><p>Glicko-2 Driver Rating, Automated Fault-Aware Safety Rating (0x Victim Shield), License Ladder (R → PRO) &amp; Global Hotlaps.</p></div>
      <div class="mc-card"><span class="mc-k">04 · STREETS</span><b>Speed-Cam Cops &amp; Street Radio</b><p>Roadside radar cameras dispatch CH-04 police scanner pursuits, GPS roadblock reroutes &amp; 5 km proximity CB radio.</p></div>
      <div class="mc-card"><span class="mc-k">05 · GARAGE</span><b>24 Cars &amp; Live Co-Op Showroom</b><p>Bodykits, engine swaps, live dyno, CS2-style live Auction House &amp; invite friends to watch you modify your car live.</p></div>
      <div class="mc-card"><span class="mc-k">06 · OPEN</span><b>Open source</b><p>The physics core and the game are Apache-2.0 on GitHub, and 100% ad-free.</p></div>
    </div>
    <div class="mc-pledge">
      <b>FREE HOBBY PROJECT · 100% AD-FREE</b>
      <p>Every car, all 18 cities, Single Player, Garage, Ranked Splits &amp; Private P2P lobbies are 100% free for everyone. Zero paywalls, zero trials, zero pay-to-win. Optional support via GitHub Sponsors.</p>
    </div>`;

  const renderHotlaps = () => {
    const opts = TRACK_OPTIONS.map(([id, label]) => `<button class="mc-chip ${track === id ? 'on' : ''}" data-track="${id}">${esc(label)}</button>`).join('');
    const rows = hotlapErr
      ? `<div class="mc-empty">${esc(hotlapErr)}</div>`
      : hotlaps === null
      ? `<div class="mc-empty">Loading live verified times…</div>`
      : hotlaps.length === 0
      ? `<div class="mc-empty">No verified dry hotlaps posted on this circuit yet — set the first benchmark on desktop!</div>`
      : `<div class="mc-table">${hotlaps.slice(0, 15).map((e, i) => `
          <div class="mc-trow">
            <span class="mc-pos">${String(i + 1).padStart(2, '0')}</span>
            <b class="mc-drv">${esc(e.username)}</b>
            <span class="mc-car">${esc(e.car.replace(/_/g, ' '))}</span>
            <span class="mc-time">${fmtLapMs(e.lap_ms)}</span>
          </div>`).join('')}</div>`;
    return `<div class="mc-section">
      <div class="mc-chips">${opts}</div>
      ${rows}
    </div>`;
  };

  const renderSchedule = () => {
    if (scheduleErr) return `<div class="mc-section"><div class="mc-empty">${esc(scheduleErr)}</div></div>`;
    if (schedule === null) return `<div class="mc-section"><div class="mc-empty">Fetching live official split schedule…</div></div>`;
    if (!schedule.length) return `<div class="mc-section"><div class="mc-empty">No official splits scheduled right now.</div></div>`;
    return `<div class="mc-section mc-list">${schedule.map((ev) => {
      const mins = Math.max(1, Math.ceil((ev.startsInSec || 60) / 60));
      return `<div class="mc-card">
        <div class="mc-row-head"><span class="mc-k">CLASS ${esc(ev.minLicense)}+ · ${ev.laps} LAPS</span><span class="mc-mono">IN ${mins} MIN</span></div>
        <b>${esc(ev.title)}</b>
        <p>${esc(ev.subtitle)} · ${ev.registrants} registered · Max ${ev.maxPerSplit}/split</p>
      </div>`;
    }).join('')}</div>`;
  };

  const renderProfile = () => {
    if (!cloud.available) {
      return `<div class="mc-section"><div class="mc-empty">Cloud backend is not configured on this preview build.</div></div>`;
    }
    if (profile && profile.email) {
      const lic = profile.license ?? 'R';
      const dr = Math.round(profile.dr ?? 1500);
      const sr = (profile.sr ?? 2.5).toFixed(2);
      const st = profile.stats ?? { starts: 0, wins: 0, podiums: 0, poles: 0, incidents: 0, corners: 0 };
      return `<div class="mc-section">
        <div class="mc-prof-head">
          <div><span class="mc-k">OPENGRID DRIVER</span><h3>${esc(profile.username || profile.name)}</h3><small>${esc(profile.email)}</small></div>
          <span class="mc-lic">CLASS ${esc(lic)}</span>
        </div>
        <div class="mc-stats">
          <div><span>DRIVER RATING</span><b>${dr}</b><em>Grade ${esc(profile.drGrade ?? 'C')}</em></div>
          <div><span>SAFETY RATING</span><b>${sr}</b><em>/ 4.99 · ${profile.cleanStreak ?? 0} clean</em></div>
          <div><span>ONLINE ACCESS</span><b>100% FREE</b><em>${profile.jokersLeft ?? 2} jokers left</em></div>
          <div><span>CAREER</span><b>${st.wins}W / ${st.podiums}P</b><em>${st.starts} starts · ${profile.credits.toLocaleString()} Cr</em></div>
        </div>
        <div class="mc-actions" style="margin-top:12px">
          <button type="button" class="mc-btn" id="mc-refresh">↻ Refresh Stats</button>
          <button type="button" class="mc-btn" id="mc-logout">Sign Out</button>
        </div>
      </div>`;
    }
    const oauthBtns = [
      oauthProviders.google ? `<button type="button" class="mc-btn og-oauth google" data-oauth="google" ${authBusy ? 'disabled' : ''}>G · Continue with Google</button>` : '',
      oauthProviders.github ? `<button type="button" class="mc-btn og-oauth github" data-oauth="github" ${authBusy ? 'disabled' : ''}>⌥ · Continue with GitHub</button>` : '',
      oauthProviders.discord ? `<button type="button" class="mc-btn og-oauth discord" data-oauth="discord" ${authBusy ? 'disabled' : ''}>💬 · Continue with Discord</button>` : '',
    ].filter(Boolean).join('');
    return `<div class="mc-section">
      <div class="mc-card">
        <span class="mc-k">OPENGRID CLOUD COMPANION</span>
        <b>Check Your DR, SR &amp; License</b>
        <p>Sign in with Google, GitHub, Discord, or your Open Grid Email &amp; Password to check your live ratings, license class, and career stats on mobile.</p>
        ${oauthBtns ? `<div class="mc-oauth-col">${oauthBtns}</div>` : ''}
        <form id="mc-login-form" class="mc-form">
          <input type="email" id="mc-email" placeholder="Email address" required autocomplete="email" />
          <input type="password" id="mc-pass" placeholder="Password" required autocomplete="current-password" />
          <button type="submit" class="mc-btn primary" ${authBusy ? 'disabled' : ''}>${authBusy ? 'Signing In…' : 'Sign In with Email'}</button>
        </form>
        ${authMsg ? `<div class="mc-note">${esc(authMsg)}</div>` : ''}
      </div>
    </div>`;
  };

  const render = () => {
    const inviteBanner = inviteParty || inviteGarage
      ? `<div class="mc-invite">
          <b>${inviteGarage ? '🔧 LIVE CO-OP GARAGE INVITE' : '🏁 MULTIPLAYER PARTY INVITE'} · CODE ${esc((inviteGarage || inviteParty || '').toUpperCase())}</b>
          <span>Tap "Play in the browser" below to join.</span>
        </div>`
      : '';

    const tabBody = tab === 'overview' ? renderOverview()
      : tab === 'hotlaps' ? renderHotlaps()
      : tab === 'schedule' ? renderSchedule()
      : renderProfile();

    root.innerHTML = `
      <div class="mc-wrap">
        <header class="mc-top">
          <div class="mc-logo">OPEN<span>GRID</span></div>
          <span class="mc-pill">OPEN SOURCE RACING SIM</span>
        </header>

        ${inviteBanner}

        <section class="mc-hero">
          <div class="mc-kicker">100% AD-FREE · NON-PROFIT · OPEN SOURCE</div>
          <h1>REALISTIC HANDLING,<br/>IN YOUR BROWSER.</h1>
          <p>Open Grid runs a 240 Hz C++ tyre simulation in the browser. Phones and tablets play a lighter build with the same physics and the same online accounts; PCs get the full build, with steering-wheel support.</p>
          <div class="mc-actions">
            <button type="button" class="mc-btn primary" id="mc-share">${copyStatus || '📋 Copy open-grid.racing'}</button>
            <a class="mc-btn" href="https://discord.gg/RhKdTvAdf" target="_blank" rel="noopener">💬 Discord</a>
            <a class="mc-btn" href="https://youtube.com/@open_grid_motorsport" target="_blank" rel="noopener">▶ YouTube</a>
            <a class="mc-btn" href="https://github.com/Konstantinos-Chatzistavrou/Open-Grid" target="_blank" rel="noopener">GitHub</a>
            <a class="mc-btn" href="https://github.com/sponsors/Konstantinos-Chatzistavrou" target="_blank" rel="noopener">♥ Sponsor</a>
          </div>
        </section>

        <nav class="mc-tabs" role="tablist">
          <button type="button" class="${tab === 'overview' ? 'on' : ''}" data-tab="overview">Overview</button>
          <button type="button" class="${tab === 'hotlaps' ? 'on' : ''}" data-tab="hotlaps">Hotlaps</button>
          <button type="button" class="${tab === 'schedule' ? 'on' : ''}" data-tab="schedule">Splits</button>
          <button type="button" class="${tab === 'profile' ? 'on' : ''}" data-tab="profile">Profile</button>
        </nav>

        <main class="mc-main">${tabBody}</main>

        <footer class="mc-foot">
          <p>Code Apache-2.0 · Original Assets CC BY-NC 4.0 · Zero Ads</p>
          <button type="button" class="mc-escape" id="mc-launch-anyway">Play in the browser →</button>
        </footer>
      </div>`;

    root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => {
      b.onclick = () => {
        const next = b.dataset.tab as TabId;
        if (next === tab) return;
        tab = next;
        render();
        if (tab === 'hotlaps' && hotlaps === null) void fetchHotlaps();
        if (tab === 'schedule' && schedule === null) void fetchSchedule();
        if (tab === 'profile' && !profile) void loadAccountIfSignedIn();
      };
    });

    root.querySelectorAll<HTMLButtonElement>('[data-track]').forEach((b) => {
      b.onclick = () => {
        track = b.dataset.track || 'nyc';
        void fetchHotlaps();
      };
    });

    root.querySelector('#mc-share')?.addEventListener('click', async () => {
      const shareUrl = location.href.replace(/[?&]companion=1/g, '') || 'https://open-grid.racing';
      try {
        if (navigator.share) {
          await navigator.share({ title: 'Open Grid', text: 'Play Open Grid in your browser', url: shareUrl });
          copyStatus = '✓ Shared!';
        } else {
          await navigator.clipboard.writeText(shareUrl);
          copyStatus = '✓ Link Copied!';
        }
      } catch {
        copyStatus = 'open-grid.racing';
      }
      render();
      setTimeout(() => { copyStatus = ''; render(); }, 2500);
    });

    root.querySelectorAll<HTMLButtonElement>('[data-oauth]').forEach((b) => {
      b.onclick = async () => {
        const prov = b.dataset.oauth as OAuthProvider;
        if (!prov || authBusy) return;
        authBusy = true; authMsg = `Redirecting to ${prov}…`; render();
        try {
          location.href = await cloud.startOAuth(prov);
        } catch (err) {
          authMsg = err instanceof Error ? err.message : `Could not start ${prov} sign-in.`;
          authBusy = false; render();
        }
      };
    });

    root.querySelector('#mc-login-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = (root.querySelector('#mc-email') as HTMLInputElement)?.value.trim();
      const pass = (root.querySelector('#mc-pass') as HTMLInputElement)?.value;
      if (!email || !pass) return;
      authBusy = true; authMsg = ''; render();
      try {
        profile = await cloud.loginEmail(email, pass);
      } catch (err) {
        authMsg = err instanceof Error ? err.message : 'Login failed.';
      }
      authBusy = false;
      render();
    });

    root.querySelector('#mc-refresh')?.addEventListener('click', () => { void loadAccountIfSignedIn(); });
    root.querySelector('#mc-logout')?.addEventListener('click', async () => {
      await cloud.logout();
      profile = null;
      render();
    });

    root.querySelector('#mc-launch-anyway')?.addEventListener('click', () => {
      root.hidden = true;
      root.innerHTML = '';
      document.body.classList.remove('mobile-companion-mode');
      const ld = document.getElementById('loading');
      if (ld) ld.hidden = false;
      onLaunchAnyway();
    });
  };

  render();
  void loadAccountIfSignedIn();
}
