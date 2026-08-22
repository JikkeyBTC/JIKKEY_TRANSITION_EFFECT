'use strict';

const { spawnSync } = require('node:child_process');

const playwrightCli = require.resolve('@playwright/test/cli');
const result = spawnSync(
  process.execPath,
  [playwrightCli, 'test', 'tests/e2e/jelly-toggle-visual.spec.ts', '--reporter=list'],
  {
    cwd: process.cwd(),
    env: { ...process.env, UPDATE_JELLY_FIXTURES: '1' },
    stdio: 'inherit',
    windowsHide: true,
  },
);

if (result.error) {
  process.stderr.write(`Unable to launch jelly fixture authoring: ${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
