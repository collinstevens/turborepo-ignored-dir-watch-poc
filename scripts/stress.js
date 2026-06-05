#!/usr/bin/env node
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const root = process.cwd();
const jobId = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const stressRoot = path.join(
  root,
  '.ignored-watch-stress',
  'generated-files',
  jobId,
  'sample-target'
);

const dirs = Number(process.env.POC_STRESS_DIRS ?? 500);
const filesPerDir = Number(process.env.POC_STRESS_FILES_PER_DIR ?? 40);
const concurrency = Number(process.env.POC_STRESS_CONCURRENCY ?? 128);
const bytesPerFile = Number(process.env.POC_STRESS_BYTES_PER_FILE ?? 2048);
const startedAt = Date.now();
const payload = Buffer.alloc(bytesPerFile, 88);
let totalFiles = 0;
let totalBytes = 0;

async function writeFile(file) {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, 'w');

  try {
    await handle.write(payload);
  } finally {
    await handle.close();
  }

  totalFiles += 1;
  totalBytes += payload.length;
}

async function runLimited(items, limit, worker) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index]);
    }
  });

  await Promise.all(workers);
}

const files = [];
for (let dirIndex = 0; dirIndex < dirs; dirIndex += 1) {
  for (let fileIndex = 0; fileIndex < filesPerDir; fileIndex += 1) {
    files.push(
      path.join(
        stressRoot,
        `dir-${String(dirIndex).padStart(4, '0')}`,
        `file-${String(fileIndex).padStart(3, '0')}.bin`
      )
    );
  }
}

console.log(`[stress] root=${path.relative(root, stressRoot)}`);
console.log(`[stress] files=${files.length} concurrency=${concurrency} bytesPerFile=${bytesPerFile}`);

await runLimited(files, concurrency, writeFile);

console.log(
  `[stress] complete files=${totalFiles} totalBytes=${totalBytes} concurrency=${concurrency} durationMs=${Date.now() - startedAt}`
);
