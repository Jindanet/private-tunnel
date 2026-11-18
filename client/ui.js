'use strict';

const { stripVTControlCharacters } = require('node:util');
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const HIDE_CURSOR = '\x1b[?25l', SHOW_CURSOR = '\x1b[?25h';

function clean(value, limit = 4096) {
  return stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, limit);
}

// Terminal cells, rather than UTF-16 length: Thai marks stay with their base,
// and common CJK/emoji graphemes occupy two columns.
function cells(grapheme) {
  if (/^[\p{Mark}\u200d\ufe0e\ufe0f]+$/u.test(grapheme)) return 0;
  if (/[\p{Extended_Pictographic}\p{Regional_Indicator}\ufe0f]/u.test(grapheme)) return 2;
  const point = grapheme.codePointAt(0);
  return point >= 0x1100 && (point <= 0x115f || point === 0x2329 || point === 0x232a
    || (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f)
    || (point >= 0xac00 && point <= 0xd7a3) || (point >= 0xf900 && point <= 0xfaff)
    || (point >= 0xfe10 && point <= 0xfe6f) || (point >= 0xff01 && point <= 0xff60)
    || (point >= 0xffe0 && point <= 0xffe6) || (point >= 0x20000 && point <= 0x3fffd)) ? 2 : 1;
}

function width(text) {
  let result = 0;
  for (const { segment } of segmenter.segment(stripVTControlCharacters(text))) result += cells(segment);
  return result;
}

function fit(text, columns, pad = false) {
  if (width(text) <= columns) return text + (pad ? ' '.repeat(columns - width(text)) : '');
  let result = '', used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const size = cells(segment);
    if (used + size > columns - 3) break;
    result += segment; used += size;
  }
  return result + '...';
}

class TunnelUI {
  constructor({ plain = false, localTarget = '', tunnelType = 'http', output = process.stdout,
    lifecycle = process, env = process.env } = {}) {
    this.output = output;
    this.lifecycle = lifecycle;
    this.interactive = Boolean(output.isTTY && !plain && env.TERM !== 'dumb');
    this.color = Boolean(output.isTTY && !plain && !Object.hasOwn(env, 'NO_COLOR') && env.TERM !== 'dumb');
    this.localTarget = clean(localTarget);
    this.tunnelType = tunnelType;
    this.status = 'connecting';
    this.url = ''; this.error = ''; this.hint = '';
    this.requests = [];
    this.totalConnections = 0;
    this.lastLineCount = 0;
    this.cursorHidden = false;
    this.stopped = false;
    this.onExit = () => this.restoreCursor();
    this.onResize = () => {
      // Resizing can reflow existing console rows. Start a fresh frame rather
      // than moving the cursor into unrelated scrollback using the old width.
      this.lastLineCount = 0;
      this.restoreCursor();
      this.update(() => this.snapshot());
    };
  }

  paint(text, color = 36) { return this.color ? `\x1b[${color}m${text}\x1b[0m` : text; }
  line(text, color = 36) { this.output.write(this.paint(clean(text), color) + '\n'); }
  get columns() { return Math.max(1, Math.floor(this.output.columns || 100)); }
  get rows() { return Math.max(1, Math.floor(this.output.rows || 24)); }
  physicalRows(lines) { return lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(width(line) / this.columns)), 0); }

  init() {
    if (this.interactive) {
      this.output.on?.('resize', this.onResize);
      this.lifecycle.once('exit', this.onExit);
    }
    this.update(() => this.snapshot());
  }

  snapshot() {
    this.line('PrivateTunnel · Ctrl+C to stop');
    this.line(`Local: ${this.tunnelType} ${this.localTarget}`);
    if (this.status === 'online') {
      this.line('ONLINE · กำลังแชร์', 32);
      this.line('Public address:', 32);
      this.line(this.url, 32);
    } else this.line(this.status === 'connecting' ? 'Connecting...' : this.status, 33);
    if (this.error) this.line(`Connection error: ${this.error}`, 31);
    if (this.hint) this.line(this.hint, 33);
  }

  frame() {
    const columns = this.columns - 1;
    const separator = this.paint('─'.repeat(columns), 37);
    const lines = [this.paint('  Private Tunnel', '1;36') + this.paint('   (Ctrl+C to quit)', 37), separator, ''];
    const color = this.status === 'online' ? 32 : this.status === 'stopped' ? 37 : 33;
    lines.push(`  Status:       ${this.paint((this.status === 'online' ? '● ' : '○ ') + this.status, color)}`);
    if (this.url) {
      const label = this.status === 'stopped' ? 'Last address:' : 'Forwarding:  ';
      const type = this.tunnelType === 'tcp' ? '[TCP] ' : '';
      const forwarding = `  ${label} ${type}${this.url} → ${this.localTarget}`;
      if (width(forwarding) <= columns) {
        lines.push(`  ${label} ${this.paint(type + this.url, 32)} → ${this.localTarget}`);
      } else {
        lines.push(`  ${label} ${this.tunnelType.toUpperCase()}`);
        lines.push(this.paint(this.url, 32)); // Never truncate a copyable address.
        lines.push(fit(`  Local:        ${this.localTarget}`, columns));
      }
    } else lines.push(fit(`  Forwarding:   ${this.status === 'stopped' ? 'stopped' : this.status + '...'} → ${this.localTarget}`, columns));
    lines.push(`  Connections:  ${this.totalConnections}`);
    if (this.error) lines.push(this.paint(fit(`  Error: ${this.error}`, columns), 31));
    if (this.hint) lines.push(this.paint(fit(`  ${this.hint}`, columns), 33));

    const available = this.rows - 1 - this.physicalRows(lines);
    if (available >= 5) {
      const methodW = 9, statusW = 8, timeW = 9;
      const pathW = columns - 2 - methodW - statusW - timeW - 3;
      lines.push('', separator, this.paint('  ' + 'METHOD'.padEnd(methodW) + ' ' + 'PATH'.padEnd(pathW) + ' ' + 'STATUS'.padEnd(statusW) + ' TIME', 37), separator);
      const visible = this.requests.slice(0, available - 4);
      if (!visible.length) lines.push('  Waiting for connections...');
      for (const request of visible) {
        const code = Number(request.statusCode) || 0;
        const statusColor = request.error || code >= 500 ? 31 : code >= 400 ? 33 : code >= 300 ? 36 : 32;
        lines.push('  ' + this.paint(fit(request.method, methodW, true), '1;37') + ' ' + fit(request.path, pathW, true)
          + ' ' + this.paint(fit(String(code || '-'), statusW, true), statusColor) + ' ' + fit(`${request.latency}ms`, timeW));
      }
    }
    return lines;
  }

  update(fallback) {
    const lines = this.interactive && this.columns >= 60 && this.rows >= 12 ? this.frame() : null;
    if (!lines || this.physicalRows(lines) >= this.rows) {
      this.restoreCursor(); this.lastLineCount = 0;
      fallback(); return;
    }
    let out = this.cursorHidden ? '' : HIDE_CURSOR;
    this.cursorHidden = true;
    if (this.lastLineCount) out += `\x1b[${this.lastLineCount}A\r\x1b[J`;
    this.output.write(out + lines.join('\r\n') + '\r\n');
    this.lastLineCount = this.physicalRows(lines);
  }

  setConnected(url, localTarget, tunnelType) {
    if (this.stopped) return;
    this.status = 'online'; this.url = clean(url);
    this.localTarget = clean(localTarget); this.tunnelType = tunnelType || 'http';
    this.error = ''; this.hint = '';
    this.update(() => {
      this.line('ONLINE · กำลังแชร์', 32); this.line('Public address:', 32);
      this.line(this.url, 32); this.line(`Local: ${this.tunnelType} ${this.localTarget}`);
    });
  }

  setDisconnected() {
    if (this.stopped) return;
    this.status = 'reconnecting'; this.url = '';
    this.update(() => this.line('Disconnected · กำลังเชื่อมต่อใหม่ / Reconnecting...', 33));
  }

  setError(message, hint = '') {
    if (this.stopped) return;
    this.error = clean(message, 2000); this.hint = clean(hint, 500);
    this.update(() => { this.line(`Connection error: ${this.error}`, 31); if (this.hint) this.line(this.hint, 33); });
  }

  addRequest(info) {
    if (this.stopped) return;
    this.totalConnections++;
    const request = { method: clean(info.method, 20), path: clean(info.path || '/'),
      statusCode: info.statusCode, latency: Number.isFinite(Number(info.latency)) ? Math.max(0, Math.round(info.latency)) : 0,
      error: Boolean(info.error) };
    this.requests.unshift(request); this.requests.length = Math.min(this.requests.length, 50);
    // Merge request bursts into one redraw per event-loop turn.
    if (this.interactive && this.columns >= 60 && this.rows >= 12) {
      if (!this.pendingRender) this.pendingRender = setImmediate(() => { this.pendingRender = null; this.update(() => this.snapshot()); });
      this.pendingRender?.unref?.();
    } else {
      const time = new Date().toTimeString().slice(0, 8);
      this.line(fit(`${time} ${request.method} ${request.statusCode || '-'} ${request.latency}ms ${request.path}`, Math.max(20, this.columns)), request.error ? 31 : 36);
    }
  }

  restoreCursor() { if (this.cursorHidden) { this.output.write(SHOW_CURSOR); this.cursorHidden = false; } }

  stop() {
    if (this.stopped) return;
    this.stopped = true; this.status = 'stopped';
    clearImmediate(this.pendingRender); this.pendingRender = null;
    this.update(() => this.line('Stopped · หยุดแชร์แล้ว'));
    this.restoreCursor();
    this.output.removeListener?.('resize', this.onResize);
    this.lifecycle.removeListener('exit', this.onExit);
  }
}

module.exports = TunnelUI;
