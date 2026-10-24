// One owned job. IPC disconnect covers an app crash; no polling or global scan.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const [executable, ...args] = process.argv.slice(2);
if (!executable || !process.connected) process.exit(1);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, args, { cwd: process.cwd(), env: environment, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
let orphaned = false;
let stopping = false;
let force;
const kill = (signal) => {
  if (!child.pid) return;
  try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') process.exitCode = 1; }
};
const stop = () => {
  if (stopping) return;
  stopping = true;
  kill('SIGTERM');
  force = setTimeout(() => kill('SIGKILL'), 700);
};
process.on('disconnect', () => { orphaned = true; stop(); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdout.on('error', () => { orphaned = true; stop(); });
process.stderr.on('error', () => { orphaned = true; stop(); });
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
child.on('error', stop);
child.on('exit', () => kill('SIGKILL'));
child.on('close', async (code) => {
  clearTimeout(deadline); clearTimeout(force);
  kill('SIGKILL');
  if (orphaned) {
    try { await fs.rm(process.cwd(), { recursive: true, force: true }); }
    catch { process.exitCode = 1; }
  }
  const exit = () => process.stdout.write('', () => process.stderr.write('', () => process.exit(process.exitCode || (code === 0 ? 0 : 1))));
  if (process.connected) process.send({ kind: 'office-job-reaped' }, exit);
  else exit();
});
const deadline = setTimeout(stop, 15000);
