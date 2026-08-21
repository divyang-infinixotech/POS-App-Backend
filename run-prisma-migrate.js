/**
 * Run Prisma Migration Sync
 * Usage: node run-prisma-migrate.js
 * 
 * This script will:
 * 1. Apply the pending sync_schema migration
 * 2. Regenerate Prisma Client
 * 3. Show migration status
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const cwd = __dirname;
const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';

function run(cmd, label) {
  console.log(`\n📋 ${label}`);
  console.log(`   $ ${cmd}`);
  try {
    const out = execSync(cmd, { cwd, timeout: 120000, shell, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    console.log(out);
    return true;
  } catch (e) {
    console.error(`❌ ERROR: ${e.message}`);
    if (e.stdout) console.log(e.stdout);
    if (e.stderr) console.error(e.stderr);
    return false;
  }
}

console.log(`
╔═══════════════════════════════════════════════╗
║     Prisma Migration Sync                     ║
║     Syncing database with schema.prisma       ║
╚═══════════════════════════════════════════════╝
`);

// Step 1: Apply the migration
if (!run('npx.cmd prisma migrate deploy', 'Apply pending migration')) {
  console.log('\n⚠️  migrate deploy failed. Trying migrate dev...');
  run('npx.cmd prisma migrate dev --name sync_schema', 'Generate & apply migration');
}

// Step 2: Regenerate Prisma Client
run('npx.cmd prisma generate', 'Regenerate Prisma Client');

// Step 3: Verify
run('npx.cmd prisma migrate status', 'Check migration status');

console.log(`
╔═══════════════════════════════════════════════╗
║  ✅  Done!                                    ║
║  Database should be in sync with schema.      ║
╚═══════════════════════════════════════════════╝
`);
