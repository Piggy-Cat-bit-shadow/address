import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.env.ADDRESS_ROOT || (basename(app) === 'app' ? dirname(app) : app));
const runner = resolve(app, 'node_modules/tsx/dist/cli.mjs');
const composeMode = process.env.ADDRESS_DEPLOY_MODE === 'compose';

if (composeMode) {
  const composeFile = resolve(process.env.ADDRESS_COMPOSE_FILE || resolve(root, 'docker-compose.yml'));
  if (!composeFile.startsWith(`${root}/`) && composeFile !== resolve(root, 'docker-compose.yml')) {
    throw new Error('ADDRESS_COMPOSE_FILE must stay inside ADDRESS_ROOT');
  }
  const compose = spawn('docker', ['compose', '-f', composeFile, 'up', '--remove-orphans'], {
    cwd: root, env: process.env, stdio: 'inherit'
  });
  let stopping = false;
  const stopCompose = () => {
    if (stopping) return;
    stopping = true;
    compose.kill('SIGINT');
    setTimeout(() => compose.kill('SIGKILL'), 25_000).unref();
  };
  process.once('SIGINT', stopCompose);
  process.once('SIGTERM', stopCompose);
  const result = await new Promise((resolveExit, rejectExit) => {
    compose.once('error', rejectExit);
    compose.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  if (result.signal && !stopping) throw new Error(`Docker Compose stopped with signal ${result.signal}`);
  process.exit(result.code ?? (stopping ? 0 : 1));
}

const definitions = [
  ['api', resolve(app, 'server/api/server.ts')],
  ['sync', resolve(app, 'server/sync/index.mjs')]
];
const children = new Map();
let stopping = false;

const signalTree = (child, signal) => {
  if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
    try { process.kill(-child.pid, signal); } catch {}
  }
  try { child.kill(signal); } catch {}
};

const retireLegacyInitialQueue = async () => {
  const pidFile = resolve(root, 'runtime/pids/initial-queue.pid');
  try {
    const pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
    if (Number.isSafeInteger(pid) && pid > 0) {
      const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
      if (command.includes(resolve(app, 'ops/queue-initial-sync.sh'))) process.kill(pid, 'SIGTERM');
    }
  } catch {}
  await rm(pidFile, { force: true });
};

const start = ([name, entry]) => {
  if (stopping) return;
  const child = spawn(process.execPath, [runner, entry], {
    cwd: app, env: process.env, stdio: 'inherit', detached: process.platform !== 'win32'
  });
  children.set(name, child);
  let settled = false;
  const restart = (detail) => {
    if (settled) return;
    settled = true;
    signalTree(child, 'SIGTERM');
    children.delete(name);
    if (stopping) return;
    console.error(`${name} stopped ${detail}; restarting`);
    setTimeout(() => start([name, entry]), 2_000).unref();
  };
  child.once('error', (error) => restart(`error=${error.message}`));
  child.once('exit', (code, signal) => restart(`code=${code ?? ''} signal=${signal ?? ''}`));
};

const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) signalTree(child, 'SIGTERM');
  const timer = setInterval(() => {
    if (children.size) return;
    clearInterval(timer);
    process.exit(0);
  }, 100);
  setTimeout(() => process.exit(1), 20_000).unref();
};

await retireLegacyInitialQueue();
definitions.forEach(start);
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

const apiPort = Number.parseInt(process.env.API_PORT || '8787', 10);
let healthFailures = 0;
const watchdog = setInterval(async () => {
  if (stopping || !children.has('api')) { healthFailures = 0; return; }
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/healthz`, { signal: AbortSignal.timeout(5_000) });
    healthFailures = response.ok ? 0 : healthFailures + 1;
  } catch {
    healthFailures += 1;
  }
  if (healthFailures >= 4) {
    healthFailures = 0;
    const child = children.get('api');
    if (child) {
      console.error('api unresponsive for 4 consecutive health checks; force restarting');
      signalTree(child, 'SIGKILL');
    }
  }
}, 30_000);
watchdog.unref();
