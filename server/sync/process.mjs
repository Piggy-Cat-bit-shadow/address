import { spawn } from 'node:child_process';

export const runProcess = ({
  file, args = [], env = process.env, stdio = 'inherit', signal, timeoutMs = 30 * 60_000,
  spawnImpl = spawn, terminationGraceMs = 5_000
}) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(Object.assign(new Error(`${file} aborted before start`), { code: 'SYNC_PROCESS_ABORTED' }));
    return;
  }
  const detached = process.platform !== 'win32';
  const mirrorStderr = stdio === 'inherit';
  const child = spawnImpl(file, args, {
    env,
    stdio: mirrorStderr ? ['inherit', 'inherit', 'pipe'] : stdio,
    windowsHide: true,
    detached
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    if (mirrorStderr) process.stderr.write(chunk);
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  let settled = false;
  let killTimer;
  let terminationError = null;
  const finish = (handler, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', abort);
    handler(value);
  };
  const terminate = (error) => {
    if (terminationError) return;
    terminationError = error;
    if (detached && child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    } else {
      try { child.kill('SIGTERM'); } catch {}
    }
    killTimer = setTimeout(() => {
      if (detached && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      } else {
        try { child.kill('SIGKILL'); } catch {}
      }
    }, terminationGraceMs);
    killTimer.unref?.();
  };
  const abort = () => {
    terminate(Object.assign(new Error(`${file} aborted`), { code: 'SYNC_PROCESS_ABORTED' }));
  };
  const timeout = setTimeout(() => {
    terminate(Object.assign(new Error(`${file} exceeded ${timeoutMs}ms`), { code: 'SYNC_PROCESS_TIMEOUT' }));
  }, Math.max(1_000, timeoutMs));
  timeout.unref?.();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  child.once('error', (error) => {
    finish(reject, terminationError || error);
  });
  child.once('close', (code, closeSignal) => {
    if (terminationError) finish(reject, terminationError);
    else if (code === 0) finish(resolve);
    else {
      const detail = stderr.trim();
      finish(reject, Object.assign(
        new Error(`${file} exited with ${closeSignal ? `signal ${closeSignal}` : `code ${code}`}${detail ? `: ${detail}` : ''}`),
        { code: closeSignal ? 'SYNC_PROCESS_ABORTED' : 'SYNC_PROCESS_FAILED', stderr: detail || null }
      ));
    }
  });
});

export const shellCommand = (command) => process.platform === 'win32'
  ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
  : { file: '/bin/sh', args: ['-lc', command] };
