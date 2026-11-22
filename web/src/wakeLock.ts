// Screen Wake Lock while a session is live. Phones (and laptops) dim and lock the screen after a while without
// a touch, key or mouse event, and a gamepad driver never sends one. The browser drops the lock whenever the tab
// hides, so it is taken again on return. Where the API is missing or the request is denied (battery saver),
// nothing happens. Idea from an October phone-tier draft that never reached main.
type Sentinel = { release(): Promise<void>; addEventListener(type: 'release', fn: () => void): void };
type WakeNavigator = Navigator & { wakeLock?: { request(type: 'screen'): Promise<Sentinel> } };

export class ScreenAwake {
  private lock: Sentinel | null = null;
  private want = false;
  private pending = false;

  constructor() {
    document.addEventListener('visibilitychange', () => { if (!document.hidden && this.want) void this.acquire(); });
  }

  /** true while driving; cheap to call on every state change */
  set(on: boolean) {
    if (on === this.want) return;
    this.want = on;
    if (on) { void this.acquire(); return; }
    const l = this.lock;
    this.lock = null;
    void l?.release().catch(() => {});
  }

  private async acquire() {
    const wl = (navigator as WakeNavigator).wakeLock;
    if (this.lock || this.pending || document.hidden || !wl) return;
    this.pending = true;
    try {
      const l = await wl.request('screen');
      if (!this.want) { void l.release().catch(() => {}); return; }
      this.lock = l;
      l.addEventListener('release', () => { if (this.lock === l) this.lock = null; });
    } catch { /* denied (battery saver, no user activation yet) */ } finally {
      this.pending = false;
    }
  }
}
