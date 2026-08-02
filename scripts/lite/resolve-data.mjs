import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { computeDataFingerprints } from './data-fingerprint.mjs';
import { restoreSnapshotBundle } from './snapshot.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const execFileAsync = promisify(execFile);
const allowedEvents = new Set(['schedule', 'workflow_dispatch']);

export const workflowRequest = ({ eventName, requestedMode = 'auto', deploy = false }) => {
  if (eventName === 'schedule') return { requestedMode: 'refresh', deployRequested: true, forcedReason: 'scheduled_refresh' };
  if (!['auto', 'refresh'].includes(requestedMode)) throw new Error(`Unsupported data_mode: ${requestedMode}`);
  return {
    requestedMode,
    deployRequested: deploy === true || String(deploy).toLowerCase() === 'true',
    forcedReason: requestedMode === 'refresh' ? 'forced_refresh' : ''
  };
};

export const isTrustedSnapshotRun = (run, { workflowId, branch = 'main' }) => Boolean(
  run
  && Number(run.workflow_id) === Number(workflowId)
  && run.head_branch === branch
  && run.status === 'completed'
  && run.conclusion === 'success'
  && allowedEvents.has(run.event)
);

export const decideFromCandidate = ({ request, candidate }) => {
  if (request.requestedMode === 'refresh') return { decision: 'refresh', reason: request.forcedReason };
  if (!candidate) return { decision: 'refresh', reason: 'no_compatible_snapshot' };
  if (candidate.compatibility === 'reuse') return { decision: 'reuse', reason: 'compatible_snapshot' };
  if (candidate.compatibility === 'reassemble') return { decision: 'reassemble', reason: 'assemble_fingerprint_changed' };
  return { decision: 'refresh', reason: 'refresh_fingerprint_changed' };
};

const apiClient = ({ repository, token, fetchImpl = fetch }) => {
  const base = `https://api.github.com/repos/${repository}`;
  return async (path, { attempts = 3 } = {}) => {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchImpl(path.startsWith('http') ? path : `${base}${path}`, {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28'
          },
          signal: AbortSignal.timeout(30_000)
        });
        if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await new Promise((resolveWait) => setTimeout(resolveWait, attempt * 1000));
      }
    }
    throw lastError;
  };
};

const paginated = async (api, path, key, maxPages = 10) => {
  const output = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const payload = await (await api(`${path}${separator}per_page=100&page=${page}`)).json();
    const rows = payload[key] || [];
    output.push(...rows);
    if (rows.length < 100) break;
  }
  return output;
};

const findNamedFile = async (root, name) => {
  const matches = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name === name) matches.push(path);
    }
  };
  await walk(root);
  if (matches.length !== 1) throw new Error(`Artifact must contain exactly one ${name}`);
  return matches[0];
};

const downloadArtifact = async ({ api, artifact, destination }) => {
  const response = await api(artifact.archive_download_url);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error(`Unexpected Artifact ZIP size: ${bytes.length}`);
  const zip = resolve(destination, 'artifact.zip');
  await writeFile(zip, bytes);
  await execFileAsync('unzip', ['-q', '-o', zip, '-d', destination]);
};

const trustedSourceRun = async ({ api, metadata, workflowId }) => {
  const sourceRun = await (await api(`/actions/runs/${metadata.sourceRunId}`)).json();
  return isTrustedSnapshotRun(sourceRun, { workflowId }) && sourceRun.head_sha === metadata.sourceSha;
};

export const resolveData = async ({
  repository,
  token,
  eventName,
  requestedMode,
  deploy,
  outputBundle,
  now = new Date(),
  root = repositoryRoot,
  fetchImpl = fetch
}) => {
  const request = workflowRequest({ eventName, requestedMode, deploy });
  const fingerprints = await computeDataFingerprints({ root });
  const api = apiClient({ repository, token, fetchImpl });
  const workflow = await (await api('/actions/workflows/address-lite.yml')).json();
  const runs = await paginated(api, `/actions/workflows/${workflow.id}/runs?branch=main&status=success`, 'workflow_runs');
  const trustedRuns = runs.filter((run) => isTrustedSnapshotRun(run, { workflowId: workflow.id }))
    .sort((left, right) => new Date(right.created_at) - new Date(left.created_at));
  let candidate = null;
  let sawArtifact = false;
  let invalidCandidates = 0;
  const errors = [];
  for (const run of trustedRuns) {
    const artifacts = (await paginated(api, `/actions/runs/${run.id}/artifacts`, 'artifacts'))
      .filter((artifact) => artifact.name === 'address-lite-data' && artifact.expired === false)
      .sort((left, right) => new Date(right.created_at) - new Date(left.created_at));
    for (const artifact of artifacts) {
      sawArtifact = true;
      const temporary = await mkdtemp(resolve(tmpdir(), 'address-lite-candidate-'));
      try {
        await downloadArtifact({ api, artifact, destination: temporary });
        const restored = resolve(temporary, 'restored-data');
        const result = await restoreSnapshotBundle({
          bundleRoot: temporary,
          outputDataRoot: restored,
          currentRefreshFingerprint: fingerprints.refreshFingerprint,
          currentAssembleFingerprint: fingerprints.assembleFingerprint,
          expectedPublishedRunId: run.id,
          allowAssembleMismatch: true,
          root,
          now
        });
        if (!(await trustedSourceRun({ api, metadata: result.metadata, workflowId: workflow.id }))) {
          throw new Error('Snapshot source run is not a trusted successful main Address Lite run');
        }
        candidate = {
          runId: String(run.id),
          artifactId: String(artifact.id),
          compatibility: result.validation.compatibility,
          ageDays: result.validation.ageDays,
          metadata: result.metadata
        };
        await rm(outputBundle, { recursive: true, force: true });
        await mkdir(outputBundle, { recursive: true });
        for (const name of ['address-lite-data.tar.gz', 'address-lite-data.tar.gz.sha256', 'snapshot.json']) {
          await cp(await findNamedFile(temporary, name), resolve(outputBundle, name));
        }
        break;
      } catch (error) {
        invalidCandidates += 1;
        errors.push({ runId: String(run.id), artifactId: String(artifact.id), error: error.message });
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    if (candidate) break;
  }
  const decision = decideFromCandidate({ request, candidate });
  const snapshotStatus = candidate ? 'found' : sawArtifact ? 'invalid' : 'missing';
  return {
    schemaVersion: 1,
    requestedMode: request.requestedMode,
    deployRequested: request.deployRequested,
    decision: decision.decision,
    sourceMode: decision.decision === 'refresh' ? 'refresh' : 'reuse',
    assembleMode: decision.decision === 'reuse' ? 'reuse' : 'rebuild',
    reason: decision.reason,
    refreshFingerprint: fingerprints.refreshFingerprint,
    assembleFingerprint: fingerprints.assembleFingerprint,
    snapshotStatus,
    snapshotRunId: candidate?.runId || '',
    snapshotArtifactId: candidate?.artifactId || '',
    snapshotId: candidate?.metadata.snapshotId || '',
    snapshotSourceRunId: candidate?.metadata.sourceRunId || '',
    snapshotSourceSha: candidate?.metadata.sourceSha || '',
    snapshotGeneratedAt: candidate?.metadata.generatedAt || '',
    snapshotAgeDays: candidate?.ageDays ?? '',
    candidateAvailable: Boolean(candidate),
    invalidCandidates,
    candidateErrors: errors
  };
};

const arg = (args, name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

export const writeGithubOutputs = async (path, result) => {
  const scalarEntries = Object.entries(result).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value));
  await writeFile(path, `${scalarEntries.map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { flag: 'a' });
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const outputBundle = resolve(arg(args, '--output-bundle'));
  const result = await resolveData({
    repository: arg(args, '--repository', process.env.GITHUB_REPOSITORY),
    token: process.env.GITHUB_TOKEN,
    eventName: arg(args, '--event', process.env.GITHUB_EVENT_NAME),
    requestedMode: arg(args, '--requested-mode', 'auto'),
    deploy: arg(args, '--deploy', 'false'),
    outputBundle
  });
  const jsonOutput = resolve(arg(args, '--json-output', resolve(outputBundle, '..', 'decision.json')));
  await mkdir(resolve(jsonOutput, '..'), { recursive: true });
  await writeFile(jsonOutput, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const githubOutput = arg(args, '--github-output', process.env.GITHUB_OUTPUT || '');
  if (githubOutput) await writeGithubOutputs(githubOutput, result);
  console.log(JSON.stringify(result));
}
