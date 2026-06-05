#!/usr/bin/env node
import { spawn } from 'node:child_process';

const startedAt = Date.now();
const childArgs = ['out/dev-build/child.js'];

console.log(`[core wrapper] pid=${process.pid} ppid=${process.ppid} cwd=${process.cwd()}`);
console.log(`[core wrapper] command=${process.execPath} ${childArgs.join(' ')}`);

const child = spawn(process.execPath, childArgs, {
  cwd: process.cwd(),
  detached: true,
  env: process.env,
  stdio: 'inherit'
});

console.log(`[core wrapper] child pid=${child.pid}`);

let childExited = false;
let forwarding = false;

function signalChildGroup(signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      console.log(`[core wrapper] failed to send ${signal} to child group pid=${child.pid}: ${error.message}`);
    }
  }
}

for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (forwarding) {
      return;
    }

    forwarding = true;
    console.log(`[core wrapper] received ${signal}; forwarding to child group pid=${child.pid}`);
    signalChildGroup(signal);

    setTimeout(() => {
      if (!childExited) {
        console.log(`[core wrapper] child still running after ${signal}; sending SIGTERM to group pid=${child.pid}`);
        signalChildGroup('SIGTERM');
      }
    }, 250);

    setTimeout(() => {
      if (!childExited) {
        console.log(`[core wrapper] child still running after ${signal}; sending SIGKILL to group pid=${child.pid}`);
        signalChildGroup('SIGKILL');
      }
    }, 1000);
  });
}

process.on('exit', () => {
  if (!childExited) {
    signalChildGroup('SIGTERM');
  }
});

child.on('exit', (code, signal) => {
  childExited = true;
  const durationMs = Date.now() - startedAt;
  console.log(`[core wrapper] child exited code=${code ?? 'null'} signal=${signal ?? 'null'} durationMs=${durationMs}`);

  if (forwarding) {
    process.exit(0);
  }

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
