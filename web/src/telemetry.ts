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
  tireInnerC: [number, number, number, number];
  tireOuterC: [number, number, number, number];
  tireFlashFlC: number;
  boostBar: number;
  oilTempC: number;
  fuelLiters: number;
  chassisTwistDeg: number;
  airDensity: number;
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

const MOTEC_CHANNELS: readonly { name: string; short: string; unit: string }[] = [
  { name: 'Ground Speed', short: 'Speed', unit: 'km/h' },
  { name: 'Engine RPM', short: 'RPM', unit: 'rpm' },
  { name: 'Throttle Pos', short: 'Thr', unit: '%' },
  { name: 'Brake Pos', short: 'Brk', unit: '%' },
  { name: 'Steering Angle', short: 'Steer', unit: 'deg' },
  { name: 'Gear', short: 'Gear', unit: '' },
  { name: 'G Force Lat', short: 'GLat', unit: 'G' },
  { name: 'G Force Long', short: 'GLong', unit: 'G' },
  { name: 'Susp Pos FL', short: 'SuspFL', unit: 'mm' },
  { name: 'Susp Pos FR', short: 'SuspFR', unit: 'mm' },
  { name: 'Susp Pos RL', short: 'SuspRL', unit: 'mm' },
  { name: 'Susp Pos RR', short: 'SuspRR', unit: 'mm' },
  { name: 'Tire Temp FL', short: 'TTmpFL', unit: 'C' },
  { name: 'Tire Temp FR', short: 'TTmpFR', unit: 'C' },
  { name: 'Tire Temp RL', short: 'TTmpRL', unit: 'C' },
  { name: 'Tire Temp RR', short: 'TTmpRR', unit: 'C' },
  { name: 'Sideslip Angle', short: 'Slip', unit: 'deg' },
  { name: 'Yaw Rate', short: 'YawR', unit: 'deg/s' },
  { name: 'Tire Inner FL', short: 'TInFL', unit: 'C' },
  { name: 'Tire Outer FL', short: 'TOutFL', unit: 'C' },
  { name: 'Tire Flash FL', short: 'TFshFL', unit: 'C' },
  { name: 'Boost Pressure', short: 'Boost', unit: 'bar' },
  { name: 'Oil Temp', short: 'OilT', unit: 'C' },
  { name: 'Fuel Level', short: 'Fuel', unit: 'L' },
  { name: 'Chassis Twist', short: 'Twist', unit: 'deg' },
  { name: 'Air Density', short: 'AirRho', unit: 'kg/m3' },
];

export class TelemetrySystem {
  /** O(1) circular ring buffer (SoA: 26 Float32Array channels, lazily allocated on first sample — zero per-tick allocations). */
  private chans: Float32Array[] | null = null;
  private head = 0;
  private count = 0;
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
  /** Persistent scratch sample reused only when live SimHub UDP streaming is open. */
  private simSample: WebTelemetrySample = {
    t: 0, speedMs: 0, rpm: 0, maxRpm: 8000, gear: 1, throttle: 0, brake: 0, steer: 0,
    gLat: 0, gLong: 0, sideslipDeg: 0, yawRateDeg: 0,
    suspMm: [0, 0, 0, 0], tireTempC: [78, 78, 78, 78], tireInnerC: [78, 78, 78, 78], tireOuterC: [78, 78, 78, 78],
    tireFlashFlC: 78, boostBar: 0, oilTempC: 85, fuelLiters: 55, chassisTwistDeg: 0, airDensity: 1.225,
    slipRatio: [0, 0, 0, 0], lap: 0, lapCur: 0, lapLast: 0, lapBest: 0, distM: 0,
  };

  driver = 'OpenGrid Driver';
  vehicle = 'Vela GT';
  venue = 'New York Midtown';

  get sampleCount() { return this.count; }
  get durationSec() { return this.count / 60; }
  get simhubConnected() { return this.ws?.readyState === WebSocket.OPEN; }
  get simhubEnabled() { return this.udpEnabled; }

  reset(driver: string, vehicle: string, venue: string) {
    this.driver = driver;
    this.vehicle = vehicle;
    this.venue = venue;
    this.head = 0;
    this.count = 0;
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

    if (!this.chans) {
      this.chans = Array.from({ length: MOTEC_CHANNELS.length }, () => new Float32Array(MAX_SAMPLES));
    }

    const w0 = OUT.wheel(0), w1 = OUT.wheel(1), w2 = OUT.wheel(2), w3 = OUT.wheel(3);
    const mass = Math.max(400, info.mass || 1450);
    const speedMs = Math.abs(out[OUT.speed] || 0);
    const rpm = out[OUT.rpm] || 0;
    const gear = Math.round(out[OUT.gear] ?? 1);
    const gLat = (out[OUT.force] || 0) / (mass * G);
    const gLong = (out[OUT.force + 2] || 0) / (mass * G);
    const sideslipDeg = (out[OUT.sideslip] || 0) * RAD2DEG;
    const yawRateDeg = ((out[OUT.torque + 1] || 0) / Math.max(100, info.inertia[1] || 2100)) * RAD2DEG;
    const s0 = (out[w0 + 9] || 0) * 1000;
    const s1 = (out[w1 + 9] || 0) * 1000;
    const s2 = (out[w2 + 9] || 0) * 1000;
    const s3 = (out[w3 + 9] || 0) * 1000;
    const t0 = out[OUT.treadSurface(0)] || out[OUT.wheelExt(0) + 2] || 78;
    const t1 = out[OUT.treadSurface(1)] || out[OUT.wheelExt(1) + 2] || 78;
    const t2 = out[OUT.treadSurface(2)] || out[OUT.wheelExt(2) + 2] || 78;
    const t3 = out[OUT.treadSurface(3)] || out[OUT.wheelExt(3) + 2] || 78;
    const ti0 = out[OUT.tireInner(0)] || out[OUT.treadSurface(0)] || 78;
    const to0 = out[OUT.tireOuter(0)] || out[OUT.treadSurface(0)] || 78;
    const tf0 = out[OUT.tireFlash(0)] || out[OUT.treadSurface(0)] || 78;
    const boostBar = out[OUT.boostBar] || 0;
    const oilTempC = out[OUT.oilTemp] || 85;
    const fuelLiters = out[OUT.fuelLiters] || 55;
    const chassisTwistDeg = out[OUT.chassisTwist] || 0;
    const airDensity = out[OUT.airDensity] || 1.225;

    const idx = this.head;
    const ch = this.chans;
    ch[0][idx] = speedMs * 3.6;
    ch[1][idx] = rpm;
    ch[2][idx] = throttle * 100;
    ch[3][idx] = brake * 100;
    ch[4][idx] = steer * 360;
    ch[5][idx] = gear - 1;
    ch[6][idx] = gLat;
    ch[7][idx] = gLong;
    ch[8][idx] = s0;
    ch[9][idx] = s1;
    ch[10][idx] = s2;
    ch[11][idx] = s3;
    ch[12][idx] = t0;
    ch[13][idx] = t1;
    ch[14][idx] = t2;
    ch[15][idx] = t3;
    ch[16][idx] = sideslipDeg;
    ch[17][idx] = yawRateDeg;
    ch[18][idx] = ti0;
    ch[19][idx] = to0;
    ch[20][idx] = tf0;
    ch[21][idx] = boostBar;
    ch[22][idx] = oilTempC;
    ch[23][idx] = fuelLiters;
    ch[24][idx] = chassisTwistDeg;
    ch[25][idx] = airDensity;

    this.head = idx + 1 >= MAX_SAMPLES ? 0 : idx + 1;
    if (this.count < MAX_SAMPLES) this.count++;

    if (this.udpEnabled && this.ws?.readyState === WebSocket.OPEN) {
      const s = this.simSample;
      s.t = this.elapsed;
      s.speedMs = speedMs;
      s.rpm = rpm;
      s.maxRpm = info.redline || 8000;
      s.gear = gear;
      s.throttle = throttle;
      s.brake = brake;
      s.steer = steer;
      s.gLat = gLat;
      s.gLong = gLong;
      s.sideslipDeg = sideslipDeg;
      s.yawRateDeg = yawRateDeg;
      s.suspMm[0] = s0; s.suspMm[1] = s1; s.suspMm[2] = s2; s.suspMm[3] = s3;
      s.tireTempC[0] = t0; s.tireTempC[1] = t1; s.tireTempC[2] = t2; s.tireTempC[3] = t3;
      s.tireInnerC[0] = ti0;
      s.tireInnerC[1] = out[OUT.tireInner(1)] || out[OUT.treadSurface(1)] || 78;
      s.tireInnerC[2] = out[OUT.tireInner(2)] || out[OUT.treadSurface(2)] || 78;
      s.tireInnerC[3] = out[OUT.tireInner(3)] || out[OUT.treadSurface(3)] || 78;
      s.tireOuterC[0] = to0;
      s.tireOuterC[1] = out[OUT.tireOuter(1)] || out[OUT.treadSurface(1)] || 78;
      s.tireOuterC[2] = out[OUT.tireOuter(2)] || out[OUT.treadSurface(2)] || 78;
      s.tireOuterC[3] = out[OUT.tireOuter(3)] || out[OUT.treadSurface(3)] || 78;
      s.tireFlashFlC = tf0;
      s.boostBar = boostBar;
      s.oilTempC = oilTempC;
      s.fuelLiters = fuelLiters;
      s.chassisTwistDeg = chassisTwistDeg;
      s.airDensity = airDensity;
      s.slipRatio[0] = out[w0 + 7] || 0;
      s.slipRatio[1] = out[w1 + 7] || 0;
      s.slipRatio[2] = out[w2 + 7] || 0;
      s.slipRatio[3] = out[w3 + 7] || 0;
      s.lap = lap?.laps ?? 0;
      s.lapCur = lap?.current ?? 0;
      s.lapLast = lap?.last ?? 0;
      s.lapBest = lap?.best ?? 0;
      s.distM = lap?.distance ?? 0;
      this.packSimHub(s);
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
    const channels = MOTEC_CHANNELS;
    const HEADER = 1762;
    const CHAN_HDR = 124;
    const n = this.count;
    const start = this.count === MAX_SAMPLES ? this.head : 0;
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
      const src = this.chans?.[c];
      if (src) {
        for (let i = 0; i < n; i++) {
          const ri = start + i < MAX_SAMPLES ? start + i : start + i - MAX_SAMPLES;
          view.setFloat32(cDataPtr + i * 4, src[ri], true);
        }
      }
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
    return { samples: this.count, bytes: ld.byteLength };
  }
}
