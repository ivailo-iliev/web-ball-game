// Resource ownership for the optional POSIX Netlify/Chromium driver.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { access, rm } from 'node:fs/promises';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function resources(log) {
  const browsers = [], pending = [];
  let server, cleanupPromise, ownsState = false, cleaning = false, spawnError;
  async function acquire(launch) {
    if (cleaning) throw new Error('Resource cleanup already started');
    const promise = launch().then(browser => { browsers.push(browser); return browser; });
    pending.push(promise);
    const browser = await promise;
    if (cleaning) throw new Error('Browser acquisition interrupted by cleanup');
    return browser;
  }
  const kill = signal => {
    if (!server?.pid) return;
    try { process.kill(-server.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  async function start() {
    if (process.platform === 'win32') throw new Error('This process-group cleanup driver requires POSIX (Linux/macOS/WSL).');
    ownsState = await access('.netlify').then(() => false, () => true);
    const socket = createServer();
    try {
      socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
      const port = socket.address().port;
      await new Promise(resolve => socket.close(resolve));
      if (cleaning) throw new Error('Netlify startup interrupted by cleanup');
      // Explicit absolute paths are essential in git worktrees: Netlify otherwise
      // resolves the functions folder against the main checkout's git root.
      server = spawn('./node_modules/.bin/netlify', ['dev', '--offline', '--no-open', '--skip-gitignore', '--framework', '#static', '--dir', process.cwd(), '--functions', `${process.cwd()}/netlify/functions`, '--port', String(port)], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, BROWSER: 'none', NETLIFY_CLI_TELEMETRY_DISABLED: '1' }
      });
      server.on('error', error => { spawnError = error; log(`Netlify spawn error: ${error.message}`); });
      for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => log(chunk.toString()));
      return `http://localhost:${port}`;
    } finally { if (socket.listening) await new Promise(resolve => socket.close(resolve)); }
  }
  function cleanup() {
    return cleanupPromise ??= (async () => {
      cleaning = true;
      await Promise.allSettled(pending);
      const results = await Promise.allSettled(browsers.map(browser => browser.close()));
      kill('SIGTERM'); await delay(500); kill('SIGKILL');
      if (server && server.exitCode === null && server.signalCode === null) await Promise.race([once(server, 'exit'), delay(2000)]);
      if (ownsState) await rm('.netlify', { recursive: true, force: true });
      assertClean(results);
      console.log(`CLEANUP: all acquired browsers closed; Netlify process group terminated; ${ownsState ? 'owned local state removed' : 'pre-existing local state retained'}`);
    })();
  }
  function assertClean(results) {
    for (const browser of browsers) if (browser.isConnected()) throw new Error('Browser still connected after cleanup');
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Browser cleanup failed');
    if (server?.pid) {
      try { process.kill(-server.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') return; throw error; }
      throw new Error(`Netlify process group ${server.pid} still exists after cleanup`);
    }
  }
  const interrupts = ['SIGINT', 'SIGTERM'].map(signal => {
    const handler = () => { void cleanup().then(() => process.exit(signal === 'SIGINT' ? 130 : 143), error => { console.error(error); process.exit(1); }); };
    process.once(signal, handler); return [signal, handler];
  });
  return { browsers, start, acquire, cleanup, exitCode: () => { if (spawnError) throw spawnError; return server?.exitCode; }, removeSignalHandlers: () => interrupts.forEach(([signal, handler]) => process.removeListener(signal, handler)) };
}
