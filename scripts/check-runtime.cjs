const fs = require('node:fs');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
try {
  if (process.argv[2] === 'dependencies') {
    const lock = JSON.parse(fs.readFileSync(path.join(project, 'package-lock.json'), 'utf8'));
    for (const name of ['playwright', 'esbuild', 'typescript', 'tsx']) {
      const installed = JSON.parse(fs.readFileSync(path.join(project, 'node_modules', name, 'package.json'), 'utf8'));
      if (installed.version !== lock.packages['node_modules/' + name].version) process.exit(1);
    }
  } else if (process.argv[2] === 'browser') {
    const { chromium } = require(path.join(project, 'node_modules', 'playwright'));
    if (!fs.existsSync(chromium.executablePath())) process.exit(1);
  } else process.exit(1);
} catch { process.exit(1); }
