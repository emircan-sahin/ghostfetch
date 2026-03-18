// CycleTLS registers process.on('exit') / SIGINT / SIGTERM handlers that try
// to kill the Go subprocess. After our destroy() call the process is already
// gone, so the kill() throws ESRCH. We patch process.kill to silently ignore
// that specific error.
const originalKill = process.kill.bind(process);
process.kill = function (pid: number, signal?: string | number) {
  try {
    return originalKill(pid, signal);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return true;
    throw err;
  }
} as typeof process.kill;
