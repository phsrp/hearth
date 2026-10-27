// Discord Rich Presence over Discord's local IPC pipe (no library needed). Reconnects on its own when Discord restarts.
const net = require('net');
const crypto = require('crypto');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

class DiscordRpc {
  constructor() { this.clientId = null; this.sock = null; this.ready = false; this.activity = null; this.retry = null; this.connecting = false; }

  setClientId(id) {
    id = String(id || '').trim();
    if (id === this.clientId) return;
    this.clientId = id || null;
    this.disconnect();
    if (this.clientId && this.activity) this.connect();
  }

  // null clears the presence
  set(activity) {
    this.activity = activity;
    if (!this.clientId) return;
    if (this.ready) this.send();
    else if (activity) this.connect();
  }

  connect(i = 0) {
    if (this.connecting || this.ready || !this.clientId) return;
    if (i > 9) { this.connecting = false; this.scheduleRetry(); return; }
    this.connecting = true;
    const sock = net.createConnection(`\\\\?\\pipe\\discord-ipc-${i}`);
    sock.once('error', () => { sock.destroy(); this.connecting = false; this.connect(i + 1); });
    sock.once('connect', () => {
      this.sock = sock;
      sock.removeAllListeners('error');
      sock.on('error', () => {});
      sock.on('close', () => { this.ready = false; this.sock = null; this.connecting = false; if (this.activity) this.scheduleRetry(); });
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 8) {
          const op = buf.readInt32LE(0);
          const len = buf.readInt32LE(4);
          if (buf.length < 8 + len) break;
          let msg = {};
          try { msg = JSON.parse(buf.subarray(8, 8 + len).toString('utf8')); } catch {}
          buf = buf.subarray(8 + len);
          if (op === OP.PING) this.write(OP.PONG, msg);
          else if (op === OP.CLOSE) { this.error = msg.message || 'Discord closed the connection.'; sock.destroy(); }
          else if (msg.evt === 'READY') { this.ready = true; this.error = null; this.connecting = false; this.send(); }
        }
      });
      this.write(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
    });
  }

  scheduleRetry() {
    clearTimeout(this.retry);
    this.retry = setTimeout(() => { if (this.activity && !this.ready) this.connect(); }, 15000);
  }

  write(op, data) {
    if (!this.sock) return;
    const body = Buffer.from(JSON.stringify(data), 'utf8');
    const head = Buffer.alloc(8);
    head.writeInt32LE(op, 0);
    head.writeInt32LE(body.length, 4);
    this.sock.write(Buffer.concat([head, body]));
  }

  send() {
    this.write(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: this.activity || undefined }, nonce: crypto.randomUUID() });
  }

  disconnect() {
    clearTimeout(this.retry);
    if (this.sock) { try { this.sock.destroy(); } catch {} }
    this.sock = null; this.ready = false; this.connecting = false;
  }
}

module.exports = { DiscordRpc };
