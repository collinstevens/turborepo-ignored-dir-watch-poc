#!/usr/bin/env node
import { spawn } from 'node:child_process';

const startedAt = Date.now();
const turboArgs = ['turbo', 'watch', 'apps-core#dev', '--ui=stream', '--no-update-notifier'];

console.log(`[root dev] command=npx ${turboArgs.join(' ')}`);

const turbo = spawn('npx', turboArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit'
});

console.log(`[root dev] Turbo pid=${turbo.pid}`);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`[root dev] forwarding ${signal} to Turbo pid=${turbo.pid}`);
    turbo.kill(signal);
  });
}

turbo.on('exit', (code, signal) => {
  const durationMs = Date.now() - startedAt;
  console.log(`[root dev] Turbo exited code=${code ?? 'null'} signal=${signal ?? 'null'} durationMs=${durationMs}`);

  if (typeof code === 'number') {
    process.exit(code);
  }

  if (signal === 'SIGINT') {
    process.exit(130);
  }

  if (signal === 'SIGTERM') {
    process.exit(143);
  }

  process.exit(1);
});
