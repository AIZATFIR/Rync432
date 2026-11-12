import { readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');
const sourceRoots = ['api', 'server', 'public/js', 'scripts'];

function collectJavaScript(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectJavaScript(entryPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
  });
}

const sourceFiles = sourceRoots.flatMap(root => collectJavaScript(path.join(projectRoot, root)));
const syntaxErrors = [];
for (const file of sourceFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) syntaxErrors.push(`${path.relative(projectRoot, file)}\n${result.stderr || result.stdout}`);
}

const html = readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
const assetReferences = [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>/gi)]
  .map(match => match[1])
  .filter(reference => reference.startsWith('/') && !reference.startsWith('//'));
const missingAssets = assetReferences.filter(reference => {
  const assetPath = path.resolve(publicRoot, `.${reference}`);
  return !assetPath.startsWith(`${publicRoot}${path.sep}`) || !existsSync(assetPath);
});

if (syntaxErrors.length || missingAssets.length) {
  if (syntaxErrors.length) process.stderr.write(`${syntaxErrors.join('\n')}\n`);
  if (missingAssets.length) process.stderr.write(`Missing public assets: ${missingAssets.join(', ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Build checks passed: ${sourceFiles.length} JavaScript files, ${assetReferences.length} local assets.\n`);
}
