import { expect, test } from '@playwright/test';
import { chromium } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const developmentUrl = 'http://127.0.0.1:5173/jelly-toggle.html';

async function waitForVite(process: ChildProcess): Promise<void> {
  const output: string[] = [];
  process.stdout?.on('data', (chunk) => output.push(String(chunk)));
  process.stderr?.on('data', (chunk) => output.push(String(chunk)));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) {
      throw new Error(`Vite exited before readiness: ${output.join('')}`);
    }
    try {
      const response = await fetch(developmentUrl);
      if (response.ok) return;
    } catch {
      // The local server has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Vite did not become ready: ${output.join('')}`);
}

async function stopProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill();
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    process.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

test('build outputs carry the nonce required by both renderer CSPs', async () => {
  for (const entry of ['index.html', 'jelly-toggle.html']) {
    const html = await readFile(path.join(root, 'dist-renderer', entry), 'utf8');
    expect(html).toContain("style-src 'self' 'nonce-jelly-toggle-vite'");
    expect(html).toContain('property="csp-nonce" nonce="jelly-toggle-vite"');
    const generatedTags = html.match(/<(?:script|link)\b[^>]*>/g) ?? [];
    expect(generatedTags.length).toBeGreaterThan(0);
    expect(generatedTags.filter((tag) => !tag.includes('nonce="jelly-toggle-vite"'))).toEqual([]);
  }
});

test('Vite dev serves the fully styled standalone control without CSP errors', async () => {
  const vite = spawn(process.execPath, [
    path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--host', '127.0.0.1',
    '--port', '5173',
    '--strictPort',
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await waitForVite(vite);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.goto(developmentUrl, { waitUntil: 'networkidle' });
    const toggle = page.getByRole('switch', { name: 'Jelly toggle' });
    await toggle.waitFor();
    const sizes = await toggle.evaluate((button) => {
      const control = getComputedStyle(button);
      const canvas = getComputedStyle(button.querySelector('canvas')!);
      return {
        control: [Number.parseFloat(control.width), Number.parseFloat(control.height)],
        canvas: [Number.parseFloat(canvas.width), Number.parseFloat(canvas.height)],
      };
    });
    expect(sizes).toEqual({ control: [384, 208], canvas: [352, 176] });
    expect(consoleErrors.filter((message) => /content security policy|refused/i.test(message))).toEqual([]);
  } finally {
    await browser?.close().catch(() => undefined);
    await stopProcess(vite);
  }
});
