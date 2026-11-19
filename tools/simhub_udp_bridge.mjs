#!/usr/bin/env node
// Zero-dependency WebSocket -> UDP bridge for SimHub / Bass Shakers / Wind Simulators.
// Receives raw 311-byte Forza/SimHub Dash V2 binary frames from the OpenGrid web app over ws://127.0.0.1:20778
// and forwards them as UDP datagrams to 127.0.0.1:20777 (SimHub default Forza Horizon/Motorsport port).
//
// Usage: node tools/simhub_udp_bridge.mjs [--ws-port 20778] [--udp-host 127.0.0.1] [--udp-port 20777]
import http from 'node:http';
import crypto from 'node:crypto';
import dgram from 'node:dgram';

const args = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const WS_PORT = Number(arg('--ws-port', '20778'));
const UDP_HOST = arg('--udp-host', '127.0.0.1');
const UDP_PORT = Number(arg('--udp-port', '20777'));

const udp = dgram.createSocket('udp4');
let packetsSent = 0;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ service: 'opengrid-simhub-bridge', udpTarget: `${UDP_HOST}:${UDP_PORT}`, packetsSent }));
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b0 = buf[0], b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(need);

      if (opcode === 0x8) { socket.end(); return; }
      if (opcode === 0x2 && payload.length > 0) {
        udp.send(payload, UDP_PORT, UDP_HOST);
        packetsSent++;
      }
    }
  });
});

server.listen(WS_PORT, '127.0.0.1', () => {
  console.log(`[OpenGrid SimHub Bridge] WS ws://127.0.0.1:${WS_PORT} -> UDP ${UDP_HOST}:${UDP_PORT}`);
});
