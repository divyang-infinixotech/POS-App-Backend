const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

try {
  const result = execSync('npx.cmd prisma --version', {
    cwd: __dirname,
    encoding: 'utf8',
    timeout: 30000,
    shell: 'cmd.exe'
  });
  fs.writeFileSync(path.join(__dirname, 'prisma-version.txt'), result);
  console.log('Success:', result);
} catch (err) {
  fs.writeFileSync(path.join(__dirname, 'prisma-error.txt'), err.message + '\n' + (err.stdout || '') + '\n' + (err.stderr || ''));
  console.error('Error:', err.message);
}
