'use strict';

// Append-only output keeps public addresses copyable on narrow Termux screens
// and remains readable when redirected to a file. No cursor control is needed.
class TunnelUI {
  constructor({ plain = false, localTarget = '', tunnelType = 'http', output = process.stdout } = {}) {
    this.output = output;
    this.color = output.isTTY && !plain && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
    this.localTarget = localTarget;
    this.tunnelType = tunnelType;
    this.status = 'connecting';
    this.totalConnections = 0;
  }

  line(value, color = 36) {
    // Remote paths and error messages must not inject terminal escape codes.
    const text = String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
    this.output.write(this.color ? `\x1b[${color}m${text}\x1b[0m\n` : `${text}\n`);
  }

  init() {
    this.line('PrivateTunnel · Ctrl+C to stop');
    this.line(`Local: ${this.tunnelType} ${this.localTarget}`);
    this.line('Connecting...');
  }

  setConnected(url, localTarget, tunnelType) {
    this.status = 'online';
    this.url = url;
    this.localTarget = localTarget;
    this.tunnelType = tunnelType;
    this.line('ONLINE · กำลังแชร์', 32);
    this.line('Public address:', 32);
    this.line(url, 32);
    this.line(`Local: ${tunnelType} ${localTarget}`);
  }

  setDisconnected() {
    this.status = 'reconnecting';
    this.line('Disconnected · กำลังเชื่อมต่อใหม่ / Reconnecting...', 33);
  }

  setError(message) { this.line(`Connection error: ${message}`, 31); }

  addRequest(info) {
    this.totalConnections++;
    const time = new Date().toTimeString().slice(0, 8);
    const text = `${time} ${info.method || ''} ${info.statusCode || '-'} ${info.latency || 0}ms ${info.path || '/'}`;
    const width = Math.max(20, this.output.columns || 100);
    this.line(text.length > width ? `${text.slice(0, width - 3)}...` : text, info.error ? 31 : 36);
  }

  stop() { this.status = 'stopped'; this.line('Stopped · หยุดแชร์แล้ว'); }
}

module.exports = TunnelUI;
