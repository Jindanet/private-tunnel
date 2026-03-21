const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const YELLOW = `${ESC}[33m`;
const CYAN = `${ESC}[36m`;
const WHITE = `${ESC}[37m`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_LINE = `${ESC}[2K`;
const MOVE_UP = (n) => `${ESC}[${n}A`;
const EOL = process.platform === 'win32' ? '\r\n' : '\n';

class TunnelUI {
  constructor() {
    this.status = 'connecting';
    this.url = '';
    this.localTarget = '';
    this.requests = [];
    this.maxRequests = 50;
    this.totalConnections = 0;
    this.lastLineCount = 0;
    this.isWindows = process.platform === 'win32';
  }

  init() {
    // Enable Windows ANSI virtual terminal processing
    if (this.isWindows) {
      try {
        process.stdout._handle && process.stdout._handle.setBlocking(true);
      } catch {}
    }

    process.stdout.write(HIDE_CURSOR);

    process.on('exit', () => {
      process.stdout.write(SHOW_CURSOR + EOL);
    });

    process.on('SIGINT', () => {
      process.stdout.write(SHOW_CURSOR + EOL);
      process.exit(0);
    });

    process.stdout.on('resize', () => this.render());

    // Initial render
    this.render();
  }

  setConnected(url, localTarget) {
    this.status = 'online';
    this.url = url;
    this.localTarget = localTarget;
    this.render();
  }

  setDisconnected() {
    this.status = 'reconnecting';
    this.render();
  }

  addRequest(info) {
    this.totalConnections++;
    this.requests.unshift({
      method: info.method,
      path: info.path,
      statusCode: info.statusCode,
      latency: info.latency,
      error: info.error,
    });

    if (this.requests.length > this.maxRequests) {
      this.requests.pop();
    }

    this.render();
  }

  render() {
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 24;
    const sep = '\u2500'.repeat(cols);

    const methodW = 8;
    const statusW = 9;
    const timeW = 10;
    const pathW = Math.max(10, cols - methodW - statusW - timeW - 6);

    // Build lines array
    const lines = [];
    lines.push(`  ${BOLD}${CYAN}Private Tunnel${RESET}   ${DIM}(Ctrl+C to quit)${RESET}`);
    lines.push(`${DIM}${sep}${RESET}`);
    lines.push('');

    const statusColor = this.status === 'online' ? GREEN : YELLOW;
    const dot = this.status === 'online' ? '\u25CF' : '\u25CB';
    lines.push(`  ${DIM}Status:${RESET}      ${statusColor}${dot} ${this.status}${RESET}`);

    if (this.url) {
      lines.push(`  ${DIM}Forwarding:${RESET}  ${GREEN}${this.url}${RESET} ${DIM}\u2192${RESET} ${WHITE}${this.localTarget}${RESET}`);
    } else {
      lines.push(`  ${DIM}Forwarding:${RESET}  ${DIM}connecting...${RESET}`);
    }

    lines.push(`  ${DIM}Connections:${RESET} ${WHITE}${this.totalConnections}${RESET}`);
    lines.push('');
    lines.push(`${DIM}${sep}${RESET}`);
    lines.push(`  ${DIM}${'METHOD'.padEnd(methodW)}${'PATH'.padEnd(pathW)}${'STATUS'.padEnd(statusW)}TIME${RESET}`);
    lines.push(`${DIM}${sep}${RESET}`);

    const headerLines = lines.length;
    const availableRows = Math.max(0, rows - headerLines - 1);
    const displayCount = Math.min(this.requests.length, availableRows);

    if (displayCount === 0) {
      lines.push('');
      lines.push(`  ${DIM}Waiting for connections...${RESET}`);
    } else {
      for (let i = 0; i < displayCount; i++) {
        const r = this.requests[i];
        const method = (r.method || '').padEnd(methodW);
        const sc = r.statusCode || 0;
        const sColor = sc < 300 ? GREEN : sc < 400 ? CYAN : sc < 500 ? YELLOW : RED;
        const status = String(sc).padEnd(statusW);
        const time = `${r.latency || 0}ms`;
        let p = r.path || '/';
        p = p.length > pathW ? p.slice(0, pathW - 3) + '...' : p.padEnd(pathW);
        lines.push(`  ${BOLD}${method}${RESET}${p} ${sColor}${status}${RESET}${DIM}${time}${RESET}`);
      }
    }

    // Erase previous output and write new
    let out = '';
    if (this.lastLineCount > 0) {
      // Move cursor up and clear each line
      out += MOVE_UP(this.lastLineCount);
      for (let i = 0; i < this.lastLineCount; i++) {
        out += `\r${CLEAR_LINE}${EOL}`;
      }
      out += MOVE_UP(this.lastLineCount);
    }

    out += lines.join(EOL) + EOL;
    this.lastLineCount = lines.length;

    process.stdout.write(out);
  }
}

module.exports = TunnelUI;
