import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function stableVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    || !value.split('.').every((part) => Number.isSafeInteger(Number(part)))) {
    throw new Error('Releases require a stable package version in x.y.z form.');
  }
  return value;
}

export function planRelease({ version, lockVersion, ref, sha, release, latest, tagSha }) {
  stableVersion(version);
  if (lockVersion !== version) throw new Error('Package and lockfile versions differ.');
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('A pinned commit SHA is required.');
  const tag = `v${version}`;
  if (ref !== 'refs/heads/main' && ref !== `refs/tags/${tag}`) {
    throw new Error('Release only from main or a tag matching the package version.');
  }
  if (release && !release.draft) return { publish: false, version, tag, reason: 'This version is already published.' };
  if (release && (release.target_commitish !== sha || release.tag_name !== tag)) {
    throw new Error('An existing draft belongs to another commit/tag. Re-run its original workflow or increase the version.');
  }
  if (tagSha && tagSha !== sha) throw new Error('Existing tag points to a different commit; tags are never moved.');
  const latestVersion = latest?.tag_name?.replace(/^v/, '');
  if (latestVersion && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(latestVersion)) {
    const a = version.split('.').map(Number), b = latestVersion.split('.').map(Number);
    const index = a.findIndex((value, i) => value !== b[i]);
    if (index < 0 || a[index] < b[index]) throw new Error('Increase the package version above the latest published release.');
  }
  return { publish: true, draft: Boolean(release?.draft), version, tag, reason: release ? 'Resume unpublished draft.' : 'Build a new release.' };
}

export function releaseAssetNames(version) {
  stableVersion(version);
  return [`PrivateTunnel-v${version}-source.zip`, `PrivateTunnel-v${version}-windows-x64-unsigned.zip`,
    `ptunnel-v${version}-windows-x64.exe`, `ptunnel-v${version}-linux-x64`,
    `ptunnel-v${version}-macos-x64`, `ptunnel-v${version}-macos-arm64`];
}

export function verifyAssets(directory, version) {
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Invalid release directory.');
  const names = releaseAssetNames(version);
  const actual = fs.readdirSync(directory).filter((name) => name !== 'SHA256SUMS.txt').sort();
  if (JSON.stringify(actual) !== JSON.stringify([...names].sort())) throw new Error('Release assets are missing or unexpected.');
  const lines = names.map((name) => {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error(`Invalid release asset: ${name}`);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return `${hash}  ${name}`;
  });
  const checksum = path.join(directory, 'SHA256SUMS.txt');
  if (fs.existsSync(checksum) && (!fs.lstatSync(checksum).isFile() || fs.lstatSync(checksum).isSymbolicLink())) throw new Error('Invalid checksum file.');
  fs.writeFileSync(checksum, lines.join('\n') + '\n');
  return [...names, 'SHA256SUMS.txt'];
}

export async function inspectRelease(env, fetcher = fetch) {
  const repository = env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !env.GH_TOKEN) throw new Error('Repository and GitHub token are required.');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  const version = stableVersion(pkg.version);
  if (lock.packages?.['']?.version !== version) throw new Error('Root lockfile package version differs.');
  const get = async (resource) => {
    const result = await fetcher(`https://api.github.com/repos/${repository}/${resource}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (result.status === 404) return null;
    if (!result.ok) throw new Error(`GitHub request failed (${result.status}): ${resource}`);
    return result.json();
  };
  const release = await get(`releases/tags/v${version}`) || await get(`releases/tags/${version}`);
  const latest = await get('releases/latest');
  let ref = await get(`git/ref/tags/v${version}`);
  for (let depth = 0; ref?.object?.type === 'tag' && depth < 4; depth++) ref = await get(`git/tags/${ref.object.sha}`);
  if (ref && ref.object?.type !== 'commit') throw new Error('Tag does not resolve to a commit.');
  return planRelease({ version, lockVersion: lock.version, ref: env.GITHUB_REF, sha: env.GITHUB_SHA,
    release, latest, tagSha: ref?.object?.sha });
}

export async function run(command, env = process.env, { fetcher = fetch, execute = execFileSync } = {}) {
  if (!['plan', 'publish'].includes(command)) throw new Error('Use plan or publish.');
  const plan = await inspectRelease(env, fetcher);
  console.log(`${plan.tag}: ${plan.reason}`);
  if (command === 'plan') {
    if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
    fs.appendFileSync(env.GITHUB_OUTPUT, `publish=${plan.publish}\nversion=${plan.version}\n`);
    return;
  }
  if (!plan.publish) return;
  const directory = 'release-artifacts';
  const assets = verifyAssets(directory, plan.version);
  const gh = (args) => execute('gh', args, { env, stdio: 'inherit' });
  const repo = ['--repo', env.GITHUB_REPOSITORY];
  const checked = await inspectRelease(env, fetcher);
  if (!checked.publish) return;
  const notes = `deploy/RELEASE-${plan.version}.md`;
  if (!checked.draft) {
    gh(['release', 'create', plan.tag, ...repo, '--target', env.GITHUB_SHA, '--draft', '--title', `PrivateTunnel ${plan.version}`,
      ...(fs.existsSync(notes) ? ['--notes-file', notes] : ['--generate-notes'])]);
  }
  gh(['release', 'upload', plan.tag, ...repo, ...assets.map((name) => path.join(directory, name)), '--clobber']);
  gh(['release', 'edit', plan.tag, ...repo, '--draft=false', '--latest']);
  console.log(`Published https://github.com/${env.GITHUB_REPOSITORY}/releases/tag/${plan.tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run(process.argv[2]).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
