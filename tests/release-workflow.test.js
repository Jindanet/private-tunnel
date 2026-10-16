const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const helpers = import(pathToFileURL(path.resolve(__dirname, '../.github/scripts/release.mjs')));
const SHA = 'a'.repeat(40);
const base = { version: '1.2.0', lockVersion: '1.2.0', ref: 'refs/heads/main', sha: SHA,
  latest: { tag_name: '1.1.2' } };

test('unreleased main versions and matching tags build; released versions are immutable', async () => {
  const { planRelease } = await helpers;
  assert.equal(planRelease(base).publish, true);
  assert.equal(planRelease({ ...base, ref: 'refs/tags/v1.2.0' }).publish, true);
  assert.equal(planRelease({ ...base, release: { draft: false }, tagSha: 'b'.repeat(40) }).publish, false);
  assert.equal(planRelease({ ...base, release: { draft: true, target_commitish: SHA, tag_name: 'v1.2.0' } }).draft, true);
});

test('mismatched identities, downgrades and unsafe version text cannot publish', async () => {
  const { planRelease, stableVersion } = await helpers;
  for (const version of ['1.2.0\nattack', '01.2.0', '1.2.0;cmd', '1.2.0-beta', '../1.2.0', '1.2', '1.2.9007199254740992']) {
    assert.throws(() => stableVersion(version));
  }
  for (const patch of [{ ref: 'refs/heads/feature' }, { ref: 'refs/tags/v9.0.0' }, { lockVersion: '1.1.0' },
    { sha: 'main' }, { tagSha: 'b'.repeat(40) }, { latest: { tag_name: 'v1.3.0' } }, { latest: { tag_name: '1.2.0' } },
    { release: { draft: true, target_commitish: 'main', tag_name: 'v1.2.0' } }]) assert.throws(() => planRelease({ ...base, ...patch }));
});

function fixture(t) {
  const original = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-release-test-'));
  process.chdir(directory);
  t.after(() => {
    process.chdir(original);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('ptunnel-release-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync('package.json', JSON.stringify({ version: '1.2.0' }));
  fs.writeFileSync('package-lock.json', JSON.stringify({ version: '1.2.0', packages: { '': { version: '1.2.0' } } }));
  return { directory, env: { GITHUB_REPOSITORY: 'owner/repo', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: SHA,
    GH_TOKEN: 'test-only-not-a-real-token', GITHUB_OUTPUT: path.join(directory, 'outputs.txt') } };
}

function github({ draft = false, published = false, failure = false } = {}) {
  return async (url) => {
    const resource = new URL(url).pathname;
    if (failure) return { status: 403, ok: false };
    let body = null;
    if (resource.endsWith('/releases/latest')) body = { tag_name: '1.1.2' };
    else if (resource.endsWith('/releases/tags/v1.2.0') && (draft || published)) {
      body = { tag_name: 'v1.2.0', draft: !published, target_commitish: SHA };
    }
    return { status: body ? 200 : 404, ok: Boolean(body), json: async () => body };
  };
}

test('plan distinguishes missing releases from permission failures and writes safe job outputs', async (t) => {
  const f = fixture(t);
  const { run } = await helpers;
  await assert.rejects(run('plan', f.env, { fetcher: github({ failure: true }) }), /403/);
  assert.equal(fs.existsSync(f.env.GITHUB_OUTPUT), false);
  await run('plan', f.env, { fetcher: github() });
  assert.equal(fs.readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), 'publish=true\nversion=1.2.0\n');
});

async function assets() {
  const { releaseAssetNames } = await helpers;
  fs.mkdirSync('release-artifacts');
  for (const name of releaseAssetNames('1.2.0')) fs.writeFileSync(path.join('release-artifacts', name), 'fixture asset');
}

test('publishing requires all six assets, writes checksums and exposes only a complete draft', async (t) => {
  const f = fixture(t);
  const { run, releaseAssetNames } = await helpers;
  await assets();
  const calls = [];
  const execute = (command, args) => { assert.equal(command, 'gh'); calls.push(args); };
  const missing = path.join('release-artifacts', releaseAssetNames('1.2.0')[0]);
  fs.unlinkSync(missing);
  await assert.rejects(run('publish', f.env, { fetcher: github(), execute }), /assets/);
  assert.equal(calls.length, 0);
  fs.writeFileSync(missing, 'fixture asset');
  await run('publish', f.env, { fetcher: github(), execute });
  assert.deepEqual(calls.map((args) => args[1]), ['create', 'upload', 'edit']);
  assert.ok(calls[0].includes('--draft') && calls[0].includes('--generate-notes'));
  assert.ok(calls[0].includes(SHA));
  assert.ok(calls[2].includes('--draft=false') && calls[2].includes('--latest'));
  const lines = fs.readFileSync('release-artifacts/SHA256SUMS.txt', 'utf8').trim().split('\n');
  assert.equal(lines.length, 6);
  assert.ok(lines.every((line) => /^[a-f0-9]{64}  /.test(line)));
});

test('an upload failure leaves a draft; rerun resumes without replacing a published release', async (t) => {
  const f = fixture(t);
  const { run } = await helpers;
  await assets();
  const calls = [];
  await assert.rejects(run('publish', f.env, { fetcher: github(), execute: (_command, args) => {
    calls.push(args[1]); if (args[1] === 'upload') throw new Error('upload failed');
  } }), /upload failed/);
  assert.deepEqual(calls, ['create', 'upload']);
  calls.length = 0;
  await run('publish', f.env, { fetcher: github({ draft: true }), execute: (_command, args) => calls.push(args[1]) });
  assert.deepEqual(calls, ['upload', 'edit']);
  calls.length = 0;
  await run('publish', f.env, { fetcher: github({ published: true }), execute: (_command, args) => calls.push(args[1]) });
  assert.equal(calls.length, 0);
});

test('only the final publish job can write, and it waits for every platform', () => {
  const workflow = require('js-yaml').load(fs.readFileSync(path.resolve(__dirname, '../.github/workflows/release.yml'), 'utf8'));
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.deepEqual(workflow.jobs.publish.needs, ['plan', 'source', 'windows-desktop', 'macos-cli']);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.permissions?.contents || workflow.permissions.contents, name === 'publish' ? 'write' : 'read');
    for (const step of job.steps) if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
  }
});
