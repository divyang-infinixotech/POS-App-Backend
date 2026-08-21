/**
 * Prisma Migration Sync Script
 * Applies the manually-created sync_schema migration and regenerates Prisma Client.
 *
 * Run with: node apply-migration.js
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const cwd = __dirname;

function run(cmd, label) {
  console.log(`\n=== ${label} ===`);
  console.log(`> ${cmd}`);
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: 'utf8',
      timeout: 120000, // 2 minutes
      shell: process.platform === 'win32' ? 'cmd.exe' : true,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    console.log(output);
    return { success: true, output };
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.error(err.stderr);
    return { success: false, error: err.message, stdout: err.stdout, stderr: err.stderr };
  }
}

async function main() {
  console.log('══════════════════════════════════════════════');
  console.log('  Prisma Migration Sync Script');
  console.log('  Syncing database with schema.prisma');
  console.log('══════════════════════════════════════════════\n');

  // Check if .env exists
  if (!fs.existsSync(path.join(cwd, '.env'))) {
    console.error('ERROR: .env file not found. Please create one with DATABASE_URL.');
    process.exit(1);
  }

  // Step 1: Apply the migration
  console.log('\n--- Step 1: Applying migration ---');
  const deployResult = run('npx.cmd prisma migrate deploy', 'Apply Migration');
  if (!deployResult.success) {
    console.log('\nTrying "prisma migrate dev" as fallback (may prompt)...');
    const devResult = run('npx.cmd prisma migrate dev --name sync_schema', 'Generate & Apply Migration');
    if (!devResult.success) {
      console.error('Migration failed. Check the error above.');
      console.log('\nTrying manual SQL application through Prisma...');
    }
  }

  // Step 2: Regenerate Prisma Client
  run('npx.cmd prisma generate', 'Regenerate Prisma Client');

  // Step 3: Verify
  console.log('\n══════════════════════════════════════════════');
  console.log('  Verifying migration...');
  console.log('══════════════════════════════════════════════\n');

  run('npx.cmd prisma migrate status', 'Migration Status');

  console.log('\n══════════════════════════════════════════════');
  console.log('  Done! If all steps succeeded, your database');
  console.log('  is now synchronized with schema.prisma.');
  console.log('══════════════════════════════════════════════\n');
}

main().catch(console.error);
