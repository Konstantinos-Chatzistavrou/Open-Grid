// A WebSocket link to an Open Grid room server (server/rooms.js, see docs/self_hosting.md).
//
// party.ts talks to PeerJS objects: a Peer (our id, "call" for voice) and one DataConnection to the party leader
// (peer, open, send, on, close). The room server plays the leader, so one small class that has both shapes lets the
// party code run unchanged: Party.joinServer() hands it over as both. Voice calls are not available on a server
// (call() returns nothing), everything else is the normal party protocol.
type Handler = (arg?: unknown) => void;

export class ServerLink {
  /** our id on the server (the server's "welcome" message) */
  id = '';
  open = false;
  /** the other end, as party.ts keys its connections */
  readonly peer = 'server';
  private ws: WebSocket;
  private handlers = new Map<string, Handler[]>();

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      let m: unknown;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if ((m as { t?: string }).t === 'welcome') {
        const id = (m as { id?: unknown }).id;
        if (typeof id !== 'string' || !id) return;
        this.id = id; this.open = true;
        this.emit('open');
        return;
      }
      this.emit('data', m);
    };
    this.ws.onclose = () => { this.open = false; this.emit('close'); };
    this.ws.onerror = () => this.emit('error', new Error('Could not connect to that server.'));
  }

  on(ev: string, fn: Handler) { const l = this.handlers.get(ev) ?? []; l.push(fn); this.handlers.set(ev, l); return this; }
  once(ev: string, fn: Handler) { const w: Handler = (a) => { this.off(ev, w); fn(a); }; return this.on(ev, w); }
  off(ev: string, fn: Handler) { this.handlers.set(ev, (this.handlers.get(ev) ?? []).filter((f) => f !== fn)); return this; }
  private emit(ev: string, arg?: unknown) { for (const f of [...(this.handlers.get(ev) ?? [])]) f(arg); }

  send(m: unknown) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }
  close() { try { this.ws.close(); } catch { /* gone */ } }
  destroy() { this.close(); }
  /** PeerJS reconnects to its broker here; a server link just ends when it drops */
  reconnect() { /* nothing */ }
  /** voice calls need WebRTC peers: not available on a server */
  call(): undefined { return undefined; }
}

/** ?server= value (wss://host[:port], ws://host[:port] or just host[:port]) to a WebSocket URL and a short name for the UI. */
export function parseServerAddress(raw: string): { url: string; label: string } | null {
  const s = raw.trim();
  const m = /^(wss?:\/\/)?([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?(\/\S*)?$/i.exec(s);
  if (!m) return null;
  const host = m[2];
  const local = /^(localhost|127\.|\[::1\])/i.test(host);
  const secure = m[1] ? /^wss/i.test(m[1]) : !local;
  if (!secure && !local && location.protocol === 'https:') return null;   // the browser refuses ws:// from an https page anyway
  const port = m[3] ? `:${Number(m[3])}` : '';
  return { url: `${secure ? 'wss' : 'ws'}://${host}${port}${m[4] ?? ''}`, label: `${host}${port}` };
}
