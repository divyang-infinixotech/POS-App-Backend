/**
 * Quick script to run prisma generate
 * Usage: node run-prisma-gen.js
 */
const { execSync } = require('child_process');

const cwd = __dirname;
const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';

console.log('📋 Regenerating Prisma Client...');
try {
  const out = execSync('npx.cmd prisma generate', { cwd, timeout: 120000, shell, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  console.log(out);
  console.log('✅ Prisma Client regenerated successfully!');
} catch (e) {
  console.error(`❌ ERROR: ${e.message}`);
  if (e.stdout) console.log(e.stdout);
  if (e.stderr) console.error(e.stderr);
  process.exit(1);
}
