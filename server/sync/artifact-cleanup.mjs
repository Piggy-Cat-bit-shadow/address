import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

const temporaryFile = (name) => name.endsWith('.part')
  || name.includes('.tmp')
  || name.endsWith('.locations.idx');
const temporaryDirectory = (name, retainRaw) => name.includes('.tmp')
  || (!retainRaw && /^plateau-\d{5}-\d{4}$/u.test(name));
const ownerPid = (name) => {
  const match = name.match(/\.(\d+)\.tmp(?:\.|$)/u);
  return match ? Number.parseInt(match[1], 10) : null;
};
const cacheArtifact = (root, target) => {
  const parts = relative(root, target).split(/[\\/]/u);
  if (parts[0] === 'normalized') return parts[1] !== 'duckdb-home';
  return parts[0] === 'raw' && !parts.some((part) => part.includes('-state-'));
};
const inside = (root, target) => {
  const path = relative(root, target);
  return path && !path.startsWith('..') && !isAbsolute(path);
};
export const createSyncArtifactCleanup = ({
  cacheDir,
  isBusy = () => false,
  now = () => Date.now(),
  staleMs = 6 * 60 * 60_000,
  intervalMs = 15 * 60_000,
  retainRaw = false,
  log = console
}) => {
  const root = resolve(cacheDir);
  let timer;
  let active;

  const runOnce = async () => {
    if (isBusy()) return { skipped: true, removedFiles: 0, removedDirectories: 0, removedBytes: 0 };
    await mkdir(root, { recursive: true });
    const result = { skipped: false, removedFiles: 0, removedDirectories: 0, removedBytes: 0 };

    const walk = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (isBusy()) return;
        const target = resolve(directory, entry.name);
        if (!inside(root, target) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          const metadata = await stat(target).catch(() => null);
          const expired = metadata && now() - metadata.mtimeMs >= staleMs;
          const pid = ownerPid(entry.name);
          const removable = pid ? true : expired;
          if (removable && temporaryDirectory(entry.name, retainRaw)) {
            if (isBusy()) return;
            await rm(target, { recursive: true, force: true });
            result.removedDirectories += 1;
          } else {
            await walk(target);
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const metadata = await stat(target).catch(() => null);
        if (!metadata) continue;
        const pid = ownerPid(entry.name);
        const expired = now() - metadata.mtimeMs >= staleMs;
        const removable = temporaryFile(entry.name) ? (pid ? true : expired) : expired && cacheArtifact(root, target);
        if (!removable) continue;
        if (isBusy()) return;
        await rm(target, { force: true });
        result.removedFiles += 1;
        result.removedBytes += metadata.size;
      }
    };

    await walk(root);
    if (result.removedFiles || result.removedDirectories) {
      log.log?.(`[sync-cleanup] removed files=${result.removedFiles} directories=${result.removedDirectories} bytes=${result.removedBytes}`);
    }
    return result;
  };

  const clean = () => (active ||= runOnce().catch((error) => {
    log.error?.('[sync-cleanup] pass failed', error);
    return { skipped: false, removedFiles: 0, removedDirectories: 0, removedBytes: 0, error };
  }).finally(() => { active = null; }));

  return {
    runOnce: clean,
    start: () => {
      void clean();
      timer ||= setInterval(() => void clean(), Math.max(60_000, intervalMs));
      timer.unref?.();
      return () => {
        clearInterval(timer);
        timer = undefined;
      };
    },
    stop: async () => {
      clearInterval(timer);
      timer = undefined;
      await active;
    }
  };
};
