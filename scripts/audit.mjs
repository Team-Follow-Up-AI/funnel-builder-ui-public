import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const textExtensions = new Set(['.js', '.mjs', '.json', '.md', '.html', '.css', '.yml', '.yaml']);
const ignored = new Set(['.git', 'node_modules']);
const files = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const target = join(dir, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (textExtensions.has(extname(entry.name)) || entry.name === 'AGENTS.md') files.push(target);
  }
}

await walk(root);
const findings = [];
const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['access token', /(?:gh[pousr]_|xox[baprs]-|sk-)[A-Za-z0-9_-]{20,}/],
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['email address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ['workstation path', /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/],
  ['private commit identifier', /\b[a-f0-9]{40}\b/i],
];

for (const target of files) {
  const value = await readFile(target, 'utf8');
  if (target.endsWith('scripts/audit.mjs')) continue;
  for (const [label, pattern] of patterns) {
    if (pattern.test(value)) findings.push(`${relative(root, target)}: ${label}`);
  }
  for (const match of value.matchAll(/https?:\/\/[^\s)>"']+/g)) {
    const localLiteral = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/.test(match[0]);
    const validatedHostTemplate = /^http:\/\/\$\{(?:host|bindHost)\}/.test(match[0]);
    const loopbackPortTemplate = /^http:\/\/127\.0\.0\.1:\$\{/.test(match[0]);
    if (!localLiteral && !validatedHostTemplate && !loopbackPortTemplate) {
      findings.push(`${relative(root, target)}: external absolute URL`);
    }
  }
}

if (findings.length) {
  console.error(`Public sandbox audit failed:\n${findings.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Public sandbox audit passed (${files.length} text files): no secrets, emails, workstation paths, private commit ids, or external absolute URLs.`);
}
