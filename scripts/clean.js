#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const targets = [
  '.ignored-watch-stress',
  '.turbo',
  'apps/core/.turbo',
  'apps/core/out'
];

for (const target of targets) {
  const absolute = path.join(root, target);
  await rm(absolute, { recursive: true, force: true });
  console.log(`[clean] removed ${target}`);
}
