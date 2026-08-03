import { spawn } from 'node:child_process';

export const runProcess = ({
  file, args = [], env = process.env, stdio = 'inherit', signal, timeoutMs = 90 * 60_000
}) => new Promise((resolve, reject) => {
  const detached = process.platform !== 'win32';
  const child = spawn(file, args, { env, stdio, windowsHide: true, detached });
  let settled = false;
  const finish = (handler, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    handler(value);
  };
  const terminate = () => {
    if (detached && child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    } else {
      try { child.kill('SIGTERM'); } catch {}
    }
  };
  const abort = () => terminate();
  const timeout = setTimeout(() => {
    terminate();
    finish(reject, Object.assign(new Error(`${file} exceeded ${timeoutMs}ms`), { code: 'SYNC_PROCESS_TIMEOUT' }));
  }, Math.max(1_000, timeoutMs));
  timeout.unref?.();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  child.once('error', (error) => finish(reject, error));
  child.once('exit', (code, signal) => {
    if (code === 0) finish(resolve);
    else finish(reject, Object.assign(
      new Error(`${file} exited with ${signal ? `signal ${signal}` : `code ${code}`}`),
      { code: signal ? 'SYNC_PROCESS_ABORTED' : 'SYNC_PROCESS_FAILED' }
    ));
  });
});

export const shellCommand = (command) => process.platform === 'win32'
  ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
  : { file: '/bin/sh', args: ['-lc', command] };
