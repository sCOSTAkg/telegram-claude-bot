#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = process.cwd();

function listMarkdownFiles() {
  const output = execSync("rg --files -g '*.md'", { encoding: 'utf8' });
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !file.includes('node_modules/'));
}

function normalizeLinkTarget(rawTarget) {
  let target = rawTarget.trim();

  if ((target.startsWith('<') && target.endsWith('>'))) {
    target = target.slice(1, -1).trim();
  }

  const titleMatch = target.match(/^([^\s]+)\s+".*"$/);
  if (titleMatch) {
    target = titleMatch[1];
  }

  return target;
}

function shouldSkip(target) {
  const lower = target.toLowerCase();
  return (
    !target ||
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('tel:') ||
    lower.startsWith('data:') ||
    lower.startsWith('#')
  );
}

function checkFileLinks(filePath) {
  const text = fs.readFileSync(path.join(root, filePath), 'utf8');
  const linkRegex = /\[[^\]]+\]\(([^)]+)\)/g;
  const errors = [];

  let match;
  while ((match = linkRegex.exec(text)) !== null) {
    const rawTarget = match[1];
    const normalized = normalizeLinkTarget(rawTarget);
    if (shouldSkip(normalized)) continue;

    const cleanTarget = normalized.split('#')[0];
    if (!cleanTarget) continue;

    const decoded = decodeURIComponent(cleanTarget);
    const resolved = path.resolve(path.dirname(path.join(root, filePath)), decoded);

    if (!fs.existsSync(resolved)) {
      errors.push({
        filePath,
        target: normalized,
      });
    }
  }

  return errors;
}

function main() {
  const markdownFiles = listMarkdownFiles();
  const allErrors = markdownFiles.flatMap(checkFileLinks);

  if (allErrors.length) {
    console.error('Broken local markdown links found:');
    for (const err of allErrors) {
      console.error(`- ${err.filePath} -> ${err.target}`);
    }
    process.exit(1);
  }

  console.log(`Checked ${markdownFiles.length} markdown files. No broken local links found.`);
}

main();
