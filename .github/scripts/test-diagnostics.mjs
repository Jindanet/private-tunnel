import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.env.RUNNER_TEMP, 'ptunnel-tests.log');
if (fs.existsSync(file)) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const failures = lines.flatMap((line, index) => /^\s*not ok \d+/.test(line) ? [index] : []).slice(0, 20);
  if (!failures.length) failures.push(Math.max(0, lines.length - 60));
  for (const start of failures) {
    const detail = lines.slice(start, start + 65).join('\n').slice(0, 10000)
      .replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.log(`::error title=Test failure::${detail}`);
  }
}
