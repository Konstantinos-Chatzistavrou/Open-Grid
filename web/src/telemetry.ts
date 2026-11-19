// Browser-side Sim Racing Telemetry:
//   1. 60 Hz Telemetry Recorder capturing speed, RPM, pedals, steer, gear, G-forces, suspension travel,
//      tire temps, slip ratio/angle, and yaw rate from rs_core's `car.out`.
//   2. Genuine MoTeC i2 Pro (.ld binary + .ldx XML lap beacons) generator & browser download.
//   3. SimHub / Forza Dash V2 311-byte binary packer + optional local WebSocket->UDP bridge (`tools/simhub_udp_bridge.mjs`).
import { OUT, type CarInfo, type LapInfo } from './physics/core';

export interface WebTelemetrySample {
  t: number;
  speedMs: number;
  rpm: number;
  maxRpm: number;
  gear: number;
  throttle: number;
  brake: number;
  steer: number;
  gLat: number;
  gLong: number;
  sideslipDeg: number;
  yawRateDeg: number;
  suspMm: [number, number, number, number];
  tireTempC: [number, number, number, number];
  slipRatio: [number, number, number, number];
  lap: number;
  lapCur: number;
  lapLast: number;
  lapBest: number;
  distM: number;
}

const G = 9.80665;
const RAD2DEG = 180 / Math.PI;
const MAX_SAMPLES = 60 * 600; // 10 minutes at 60 Hz (~36,000 samples)
const SIMHUB_BYTES = 311;

export class TelemetrySystem {
  private samples: WebTelemetrySample[] = [];
  private beacons: number[] = [];
  private acc = 0;
  private elapsed = 0;
  private lastLapCount = 0;
  private ws: WebSocket | null = null;
  private udpEnabled = false;
  private udpUrl = 'ws://127.0.0.1:20778';
  private pktBuf = new ArrayBuffer(SIMHUB_BYTES);
  private pktView = new DataView(this.pktBuf);
  private pktBytes = new Uint8Array(this.pktBuf);

  driver = 'OpenGrid Driver';
  vehicle = 'Vela GT';
  venue = 'New York Midtown';

  get sampleCount() { return this.samples.length; }
  get durationSec() { return this.samples.length / 60; }
  get simhubConnected() { return this.ws?.readyState === WebSocket.OPEN; }
  get simhubEnabled() { return this.udpEnabled; }

  reset(driver: string, vehicle: string, venue: string) {
    this.driver = driver;
    this.vehicle = vehicle;
    this.venue = venue;
    this.samples.length = 0;
    this.beacons.length = 0;
    this.acc = 0;
    this.elapsed = 0;
    this.lastLapCount = 0;
  }

  /** Enable/disable live 60 Hz streaming to `tools/simhub_udp_bridge.mjs` -> SimHub UDP 20777. */
  setSimHubStream(on: boolean, url = this.udpUrl) {
    this.udpEnabled = on;
    this.udpUrl = url;
    if (!on) {
      try { this.ws?.close(); } catch { /* ignore */ }
      this.ws = null;
      return;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    try {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onclose = () => { if (this.ws === ws) this.ws = null; };
      ws.onerror = () => { /* bridge optional: silent when not running locally */ };
      this.ws = ws;
    } catch { /* blocked */ }
  }

  /** Record at 60 Hz while driving and stream SimHub UDP packets when connected. */
  tick(dt: number, active: boolean, out: Float64Array, info: CarInfo, throttle: number, brake: number, steer: number, lap: LapInfo | null) {
    if (!active) return;
    this.elapsed += dt;
    this.acc += dt;
    if (lap && lap.laps > this.lastLapCount) {
      this.lastLapCount = lap.laps;
      this.beacons.push(this.elapsed);
    }
    const step = 1 / 60;
    if (this.acc < step) return;
    this.acc = Math.min(this.acc - step, step);

    const w0 = OUT.wheel(0), w1 = OUT.wheel(1), w2 = OUT.wheel(2), w3 = OUT.wheel(3);
    const mass = Math.max(400, info.mass || 1450);
    const sample: WebTelemetrySample = {
      t: this.elapsed,
      speedMs: Math.abs(out[OUT.speed] || 0),
      rpm: out[OUT.rpm] || 0,
      maxRpm: info.redline || 8000,
      gear: Math.round(out[OUT.gear] ?? 1),
      throttle,
      brake,
      steer,
      gLat: (out[OUT.force] || 0) / (mass * G),
      gLong: (out[OUT.force + 2] || 0) / (mass * G),
      sideslipDeg: (out[OUT.sideslip] || 0) * RAD2DEG,
      yawRateDeg: ((out[OUT.torque + 1] || 0) / Math.max(100, info.inertia[1] || 2100)) * RAD2DEG,
      suspMm: [
        (out[w0 + 9] || 0) * 1000,
        (out[w1 + 9] || 0) * 1000,
        (out[w2 + 9] || 0) * 1000,
        (out[w3 + 9] || 0) * 1000,
      ],
      tireTempC: [
        out[OUT.treadSurface(0)] || out[OUT.wheelExt(0) + 2] || 78,
        out[OUT.treadSurface(1)] || out[OUT.wheelExt(1) + 2] || 78,
        out[OUT.treadSurface(2)] || out[OUT.wheelExt(2) + 2] || 78,
        out[OUT.treadSurface(3)] || out[OUT.wheelExt(3) + 2] || 78,
      ],
      slipRatio: [
        out[w0 + 7] || 0,
        out[w1 + 7] || 0,
        out[w2 + 7] || 0,
        out[w3 + 7] || 0,
      ],
      lap: lap?.laps ?? 0,
      lapCur: lap?.current ?? 0,
      lapLast: lap?.last ?? 0,
      lapBest: lap?.best ?? 0,
      distM: lap?.distance ?? 0,
    };

    if (this.samples.length >= MAX_SAMPLES) this.samples.shift();
    this.samples.push(sample);

    if (this.udpEnabled && this.ws?.readyState === WebSocket.OPEN) {
      this.packSimHub(sample);
      this.ws.send(this.pktBuf);
    }
  }

  /** Pack a 311-byte SimHub/Forza Dash V2 binary frame matching `core/src/telemetry.cpp`. */
  packSimHub(s: WebTelemetrySample): Uint8Array {
    const v = this.pktView;
    const b = this.pktBytes;
    b.fill(0);
    v.setInt32(0, 1, true);
    v.setUint32(4, Math.floor(s.t * 1000) >>> 0, true);
    v.setFloat32(8, s.maxRpm, true);
    v.setFloat32(12, 900, true);
    v.setFloat32(16, s.rpm, true);
    v.setFloat32(20, -s.gLat * G, true);
    v.setFloat32(24, 0, true);
    v.setFloat32(28, s.gLong * G, true);
    for (let i = 0; i < 4; i++) {
      v.setFloat32(68 + i * 4, Math.max(0, Math.min(1, s.suspMm[i] / 120)), true);
      v.setFloat32(84 + i * 4, s.slipRatio[i], true);
      v.setFloat32(196 + i * 4, s.suspMm[i] / 1000, true);
      v.setFloat32(256 + i * 4, s.tireTempC[i] * 1.8 + 32, true);
    }
    v.setFloat32(244, s.speedMs, true);
    v.setFloat32(280, s.distM, true);
    v.setFloat32(284, s.lapBest, true);
    v.setFloat32(288, s.lapLast, true);
    v.setFloat32(292, s.lapCur, true);
    v.setFloat32(296, s.t, true);
    v.setUint16(300, Math.max(0, s.lap), true);
    b[302] = 1;
    b[303] = Math.round(Math.max(0, Math.min(1, s.throttle)) * 255);
    b[304] = Math.round(Math.max(0, Math.min(1, s.brake)) * 255);
    b[307] = s.gear <= 1 ? 0 : Math.min(10, s.gear - 1);
    b[308] = Math.max(-127, Math.min(127, Math.round(-s.steer * 127))) & 0xff;
    return b;
  }

  /** Generate genuine MoTeC i2 Pro `.ld` binary payload. */
  buildMotecLd(): Uint8Array {
    const channels: { name: string; short: string; unit: string; fn: (s: WebTelemetrySample) => number }[] = [
      { name: 'Ground Speed', short: 'Speed', unit: 'km/h', fn: (s) => s.speedMs * 3.6 },
      { name: 'Engine RPM', short: 'RPM', unit: 'rpm', fn: (s) => s.rpm },
      { name: 'Throttle Pos', short: 'Thr', unit: '%', fn: (s) => s.throttle * 100 },
      { name: 'Brake Pos', short: 'Brk', unit: '%', fn: (s) => s.brake * 100 },
      { name: 'Steering Angle', short: 'Steer', unit: 'deg', fn: (s) => s.steer * 360 },
      { name: 'Gear', short: 'Gear', unit: '', fn: (s) => s.gear - 1 },
      { name: 'G Force Lat', short: 'GLat', unit: 'G', fn: (s) => s.gLat },
      { name: 'G Force Long', short: 'GLong', unit: 'G', fn: (s) => s.gLong },
      { name: 'Susp Pos FL', short: 'SuspFL', unit: 'mm', fn: (s) => s.suspMm[0] },
      { name: 'Susp Pos FR', short: 'SuspFR', unit: 'mm', fn: (s) => s.suspMm[1] },
      { name: 'Susp Pos RL', short: 'SuspRL', unit: 'mm', fn: (s) => s.suspMm[2] },
      { name: 'Susp Pos RR', short: 'SuspRR', unit: 'mm', fn: (s) => s.suspMm[3] },
      { name: 'Tire Temp FL', short: 'TTmpFL', unit: 'C', fn: (s) => s.tireTempC[0] },
      { name: 'Tire Temp FR', short: 'TTmpFR', unit: 'C', fn: (s) => s.tireTempC[1] },
      { name: 'Tire Temp RL', short: 'TTmpRL', unit: 'C', fn: (s) => s.tireTempC[2] },
      { name: 'Tire Temp RR', short: 'TTmpRR', unit: 'C', fn: (s) => s.tireTempC[3] },
      { name: 'Sideslip Angle', short: 'Slip', unit: 'deg', fn: (s) => s.sideslipDeg },
      { name: 'Yaw Rate', short: 'YawR', unit: 'deg/s', fn: (s) => s.yawRateDeg },
    ];

    const HEADER = 1762;
    const CHAN_HDR = 124;
    const n = this.samples.length;
    const metaPtr = HEADER;
    const dataPtr = metaPtr + channels.length * CHAN_HDR;
    const chanBytes = n * 4;
    const out = new Uint8Array(dataPtr + channels.length * chanBytes);
    const view = new DataView(out.buffer);
    const enc = new TextEncoder();
    const putStr = (off: number, cap: number, text: string) => {
      const raw = enc.encode(text);
      out.set(raw.subarray(0, Math.max(0, cap - 1)), off);
    };

    view.setUint32(0x00, 0x00000040, true);
    view.setUint32(0x08, metaPtr, true);
    view.setUint32(0x0c, dataPtr, true);
    view.setUint32(0x24, 0x00010000, true);
    view.setUint16(0x46, 0x4240, true);
    view.setUint16(0x48, 0x000f, true);
    view.setUint16(0x4a, 0x1f44, true);
    const d = new Date();
    putStr(0x5e, 16, d.toLocaleDateString('en-GB'));
    putStr(0x7e, 16, d.toTimeString().slice(0, 8));
    putStr(0x9e, 64, this.driver);
    putStr(0xde, 64, this.vehicle);
    putStr(0x15e, 64, this.venue);
    putStr(0x19e, 64, 'OpenGrid Telemetry');

    for (let c = 0; c < channels.length; c++) {
      const off = metaPtr + c * CHAN_HDR;
      const prevPtr = c === 0 ? 0 : off - CHAN_HDR;
      const nextPtr = c + 1 < channels.length ? off + CHAN_HDR : 0;
      const cDataPtr = dataPtr + c * chanBytes;
      view.setUint32(off + 0x00, prevPtr, true);
      view.setUint32(off + 0x04, nextPtr, true);
      view.setUint32(off + 0x08, cDataPtr, true);
      view.setUint32(off + 0x0c, n, true);
      view.setUint16(off + 0x10, 0x2ee1 + c, true);
      view.setUint16(off + 0x12, 0x0007, true); // float32
      view.setUint16(off + 0x14, 0x0004, true);
      view.setUint16(off + 0x16, 60, true);     // 60 Hz
      view.setUint16(off + 0x18, 0, true);
      view.setUint16(off + 0x1a, 1, true);
      view.setUint16(off + 0x1c, 1, true);
      view.setUint16(off + 0x1e, 0, true);
      putStr(off + 0x20, 32, channels[c].name);
      putStr(off + 0x40, 8, channels[c].short);
      putStr(off + 0x48, 12, channels[c].unit);
      const fn = channels[c].fn;
      for (let i = 0; i < n; i++) view.setFloat32(cDataPtr + i * 4, fn(this.samples[i]), true);
    }
    return out;
  }

  /** Generate MoTeC `.ldx` lap beacon XML sidecar. */
  buildMotecLdx(): string {
    const markers = this.beacons.map((t, i) =>
      `          <Marker Version="100" ClassName="BCN" Name="Lap ${i + 1}" Flags="77" Time="${Math.round(t * 1e6)}"/>`,
    ).join('\n');
    return `<?xml version="1.0"?>\n<LDXFile Locale="English_United States.1252" DefaultLocale="C" Version="1.6">\n  <Layers>\n    <Layer>\n      <MarkerBlock>\n        <MarkerGroup Name="Beacons" Index="${this.beacons.length}">\n${markers}\n        </MarkerGroup>\n      </MarkerBlock>\n    </Layer>\n  </Layers>\n</LDXFile>\n`;
  }

  /** Trigger browser download of both `.ld` and `.ldx` MoTeC files. */
  exportMotec(): { samples: number; bytes: number } {
    const ld = this.buildMotecLd();
    const ldx = this.buildMotecLdx();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = `opengrid_${this.venue.toLowerCase().replace(/\s+/g, '_')}_${stamp}`;
    const dl = (blob: Blob, name: string) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    dl(new Blob([ld.buffer as ArrayBuffer], { type: 'application/octet-stream' }), `${base}.ld`);
    dl(new Blob([ldx], { type: 'application/xml' }), `${base}.ldx`);
    return { samples: this.samples.length, bytes: ld.byteLength };
  }
}
