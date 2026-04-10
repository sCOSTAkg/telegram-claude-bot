#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const IGNORE_DIRS = new Set(['.git', 'node_modules']);
const ALLOWED_SHIM_HEADER = '@compat-shim';

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function getCollisionKey(relPath) {
  const ext = path.extname(relPath);
  const dir = path.dirname(relPath);
  const base = path.basename(relPath, ext);
  const normalizedBase = base.replace(/[-_]/g, '');
  return path.join(dir, `${normalizedBase}${ext}`);
}

function isCompatShim(absPath) {
  const content = fs.readFileSync(absPath, 'utf8').trim();
  return content.includes(ALLOWED_SHIM_HEADER) && /module\.exports\s*=\s*require\(/.test(content);
}

const grouped = new Map();
for (const absPath of walk(ROOT)) {
  const relPath = path.relative(ROOT, absPath);
  const key = getCollisionKey(relPath);
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(relPath);
}

const collisions = [];
for (const paths of grouped.values()) {
  if (paths.length < 2) continue;

  const absPaths = paths.map((rel) => path.join(ROOT, rel));
  const shimCount = absPaths.filter(isCompatShim).length;

  if (!(paths.length === 2 && shimCount === 1)) {
    collisions.push(paths);
  }
}

if (collisions.length > 0) {
  console.error('❌ Detected snake_case/kebab-case module name collisions:');
  for (const group of collisions) {
    console.error(`  - ${group.join(' <-> ')}`);
  }
  console.error('\nAllowed exception: exactly one compatibility shim with @compat-shim and module.exports = require(...).');
  process.exit(1);
}

console.log('✅ No forbidden module name collisions found.');
