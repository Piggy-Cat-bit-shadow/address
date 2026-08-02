import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const candidates = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);
const failures = [];
const report = (path, type) => failures.push({ path, type });

const forbidden = [
  /(^|\/)\.claude\//u,
  /(^|\/)\.codex\//u,
  /(^|\/)\.data-cache\//u,
  /(^|\/)(?:data|logs|runtime|backups|worker)\//u,
  /(^|\/)plan\.md$/u,
  /(^|\/)tmp-probe\.png$/u,
  /\.(?:db|sqlite|sqlite3|pem|p12|pfx)$/iu,
  /(^|\/)\.env(?:\.|$)/u
];

for (const path of tracked) {
  if (path.endsWith('.env.example') || path === 'ops/deploy.env.example') continue;
  if (forbidden.some((pattern) => pattern.test(path))) report(path, 'forbidden-tracked-file');
}

const secretShapes = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['github-token', /(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/u],
  ['aws-access-key', /AKIA[0-9A-Z]{16}/u],
  ['slack-token', /xox[baprs]-[A-Za-z0-9-]{20,}/u],
  ['jwt-token', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{30,}\b/u],
  ['tencent-map-key', /\b(?:[A-Z0-9]{5}-){5}[A-Z0-9]{5}\b/u]
];

for (const path of candidates) {
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  for (const [type, pattern] of secretShapes) {
    if (pattern.test(content)) report(path, type);
  }
}

for (const path of ['.env.example', 'server/sync/.env.example', 'ops/address.env.example', 'ops/deploy.env.example']) {
  const content = readFileSync(path, 'utf8');
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE)[A-Z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match || !match[2]) continue;
    if (!/(?:REPLACE|YOUR_|VPS_|SSH_|GENERATE_|RANDOM)/iu.test(match[2])) report(path, `literal-${match[1].toLowerCase()}`);
  }
}

for (const path of ['LICENSE', 'README.md', 'README.zh-CN.md', 'README.zh-TW.md', '.github/workflows/ci.yml', '.github/workflows/release.yml']) {
  if (!tracked.includes(path)) report(path, 'required-public-file-not-tracked');
}

const manifestPath = 'public/manifest.webmanifest';
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  report(manifestPath, 'invalid-or-missing-pwa-manifest');
}
if (manifest) {
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) report(manifestPath, 'missing-name');
  if (typeof manifest.short_name !== 'string' || !manifest.short_name.trim()) report(manifestPath, 'missing-short-name');
  if (typeof manifest.start_url !== 'string' || !manifest.start_url.startsWith('/')) report(manifestPath, 'invalid-start-url');
  if (!['standalone', 'minimal-ui', 'fullscreen'].includes(manifest.display)) report(manifestPath, 'invalid-display');
  if (!Array.isArray(manifest.icons) || !manifest.icons.length) report(manifestPath, 'missing-icons');
  for (const icon of manifest.icons || []) {
    const source = String(icon.src || '').replace(/^\//u, '');
    if (!source || !existsSync(resolve('public', source.replace(/^public\//u, '')))) report(source || manifestPath, 'missing-manifest-icon');
    if (!/^\d+x\d+$/u.test(String(icon.sizes || ''))) report(source || manifestPath, 'invalid-icon-size');
  }
}

const pngSize = (path) => {
  const bytes = readFileSync(path);
  return bytes.length >= 24 && bytes.subarray(1, 4).toString('ascii') === 'PNG'
    ? [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
    : [];
};
for (const [path, expected] of [
  ['public/apple-touch-icon.png', 180],
  ['public/icons/icon-192.png', 192],
  ['public/icons/icon-512.png', 512],
  ['public/icons/icon-maskable-512.png', 512]
]) {
  if (!existsSync(path)) report(path, 'missing-pwa-icon');
  else if (pngSize(path).some((value) => value !== expected) || pngSize(path).length !== 2) report(path, 'invalid-pwa-icon-dimensions');
}
if (!existsSync('public/favicon.svg')) report('public/favicon.svg', 'missing-favicon');
for (const path of tracked) {
  if (/(^|\/)(?:service-worker|sw)\.(?:js|mjs|ts)$/iu.test(path)) report(path, 'service-worker-not-allowed');
}

if (existsSync('public/build-info.json')) {
  try {
    const buildInfo = JSON.parse(readFileSync('public/build-info.json', 'utf8'));
    for (const key of ['siteSha', 'siteBuiltAt', 'dataSnapshotId', 'dataSourceSha', 'dataGeneratedAt', 'dataMode']) {
      if (!buildInfo[key]) report('public/build-info.json', `missing-${key}`);
    }
  } catch {
    report('public/build-info.json', 'invalid-build-info');
  }
}

if (failures.length) {
  for (const failure of failures.sort((left, right) => left.path.localeCompare(right.path) || left.type.localeCompare(right.type))) {
    console.error(`${failure.type}: ${failure.path}`);
  }
  process.exitCode = 1;
} else {
  console.log(`public-release audit passed (${tracked.length} tracked, ${candidates.length - tracked.length} untracked candidates)`);
}
