const startedAt = Date.now();
const bundle = globalThis.__POC_DEV_BUNDLE__ ?? {};

console.log(
  `[child] pid=${process.pid} ppid=${process.ppid} builtAt=${bundle.builtAt ?? 'unknown'} started=${new Date(startedAt).toISOString()}`
);

let heartbeat = 0;
let exiting = false;
const interval = setInterval(() => {
  heartbeat += 1;
  console.log(`[child] heartbeat=${heartbeat} uptimeMs=${Date.now() - startedAt}`);
}, 3000);

for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (exiting) {
      return;
    }

    exiting = true;
    console.log(`[child] received ${signal} uptimeMs=${Date.now() - startedAt}`);
    clearInterval(interval);
    setTimeout(() => process.exit(0), 10);
  });
}

process.on('exit', (code) => {
  console.log(`[child] exit code=${code} uptimeMs=${Date.now() - startedAt}`);
});
