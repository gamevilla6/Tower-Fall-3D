import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright';

const basePath = '/3d-game/';
const packageRoot = process.cwd();
const chromiumPath = '/repl/tools/bin/chromium';
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'portrait', width: 402, height: 874 },
];

let serverProcess;
let browser;
let serverUrl;
let serverOutput = '';

async function getAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Vite exited before becoming ready.\n${serverOutput}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The dev server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Vite did not become ready at ${url}.\n${serverOutput}`);
}

async function inspectRenderedScene(page, label, expectTower) {
  const result = await page.getByTestId('game-fallback-canvas').evaluate((canvas) => {
    if (getComputedStyle(canvas).display === 'none') {
      throw new Error('The visible 2D game canvas is hidden.');
    }
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The rendered game canvas has no 2D context.');
    const { width, height } = canvas;
    const pixels = context.getImageData(0, 0, width, height).data;
    const platformShades = [
      [42, 56, 61], [52, 71, 77], [47, 64, 69],
      [62, 84, 91], [35, 47, 51], [71, 96, 105],
    ];
    const platform = { count: 0, minX: width, minY: height, maxX: -1, maxY: -1 };
    const tower = { count: 0, minX: width, minY: height, maxX: -1, maxY: -1 };
    const include = (bounds, x, y) => {
      bounds.count += 1;
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
    };

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const red = pixels[index];
        const green = pixels[index + 1];
        const blue = pixels[index + 2];
        if (platformShades.some(([r, g, b]) =>
          Math.abs(red - r) <= 1 && Math.abs(green - g) <= 1 && Math.abs(blue - b) <= 1
        )) {
          include(platform, x, y);
        }
        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);
        if (maximum > 115 && maximum - minimum > 48) include(tower, x, y);
      }
    }
    return { width, height, platform, tower };
  });

  assert.ok(result.width > 0 && result.height > 0, `${label}: canvas has no rendered size`);
  assert.ok(result.platform.count > 80, `${label}: platform pixels missing (${JSON.stringify(result)})`);
  assert.ok(
    result.platform.minX > result.width * 0.025 &&
      result.platform.maxX < result.width * 0.975 &&
      result.platform.minY > result.height * 0.025 &&
      result.platform.maxY < result.height * 0.975,
    `${label}: platform touches the canvas edge (${JSON.stringify(result.platform)})`,
  );

  if (expectTower) {
    assert.ok(result.tower.count > 100, `${label}: tower pixels missing (${JSON.stringify(result)})`);
    assert.ok(
      result.tower.minX > result.width * 0.01 &&
        result.tower.maxX < result.width * 0.99 &&
        result.tower.minY > result.height * 0.01 &&
        result.tower.maxY < result.height * 0.99,
      `${label}: tower touches the canvas edge (${JSON.stringify(result.tower)})`,
    );
  } else {
    assert.equal(result.tower.count, 0, `${label}: restart left colored tower pixels on screen`);
  }
}

async function startRun(page) {
  await page.goto(serverUrl);
  const startButton = page.getByTestId('button-start-game');
  await startButton.waitFor({ state: 'visible', timeout: 45_000 });
  await startButton.waitFor({ state: 'attached' });
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="button-start-game"]')?.disabled,
    null,
    { timeout: 45_000 },
  );
  await startButton.click();
  await page.getByTestId('status-main-menu').waitFor({ state: 'hidden' });
}

async function assertPhoneControlsFit(page, label) {
  const layout = await page.evaluate(() => {
    const bounds = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        visible: style.visibility !== 'hidden' && style.display !== 'none',
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      pause: bounds('[data-testid="button-pause"]'),
      restart: bounds('[data-testid="button-restart"]'),
      dropPrompt: bounds('.drop-prompt'),
      canvas: bounds('.game-canvas-wrap'),
    };
  });

  for (const [name, rect] of Object.entries({
    pause: layout.pause,
    restart: layout.restart,
    dropPrompt: layout.dropPrompt,
  })) {
    assert.ok(rect?.visible, `${label}: ${name} control is not visible`);
    assert.ok(
      rect.left >= 0 && rect.top >= 0 &&
        rect.right <= layout.viewport.width && rect.bottom <= layout.viewport.height,
      `${label}: ${name} control extends beyond the viewport (${JSON.stringify(rect)})`,
    );
  }

  assert.ok(layout.pause.height >= 36, `${label}: pause control is too small to tap`);
  assert.ok(layout.restart.height >= 40, `${label}: restart control is too small to tap`);
  assert.ok(
    layout.canvas.width >= layout.viewport.width * 0.95 &&
      layout.canvas.height >= layout.viewport.height * 0.95,
    `${label}: game area does not fill the phone viewport (${JSON.stringify(layout.canvas)})`,
  );
}

async function placeBlocks(page, count) {
  const canvas = page.getByTestId('game-fallback-canvas');
  for (let score = 1; score <= count; score += 1) {
    await canvas.click({ position: { x: 30, y: 30 } });
    await page.waitForFunction(
      (expectedScore) =>
        document.querySelector('[data-testid="text-score"]')?.textContent ===
        String(expectedScore).padStart(2, '0'),
      score,
      { timeout: 10_000 },
    );
  }
}

describe('rendered camera framing', () => {
  before(async () => {
    const port = await getAvailablePort();
    serverUrl = `http://127.0.0.1:${port}${basePath}`;
    serverProcess = spawn(
      process.execPath,
      ['node_modules/vite/bin/vite.js', '--config', 'vite.config.ts', '--host', '127.0.0.1'],
      {
        cwd: packageRoot,
        env: { ...process.env, PORT: String(port), BASE_PATH: basePath },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    serverProcess.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
    serverProcess.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
    await waitForServer(serverUrl);

    browser = await chromium.launch({
      headless: true,
      ...(existsSync(chromiumPath) ? { executablePath: chromiumPath } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  });

  after(async () => {
    await browser?.close();
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill('SIGTERM');
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 3_000);
        serverProcess.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  });

  for (const viewport of viewports) {
    it(`keeps the platform and tower visible on ${viewport.name} and after resizing`, async () => {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      await context.addInitScript(() => {
        const originalGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (contextType, ...args) {
          if (contextType === 'webgl2') return null;
          return originalGetContext.call(this, contextType, ...args);
        };
        Math.random = () => 0.5;
      });
      const page = await context.newPage();
      try {
        await startRun(page);
        await inspectRenderedScene(page, `${viewport.name} at run start`, false);
        await placeBlocks(page, 5);
        await inspectRenderedScene(page, `${viewport.name} after five drops`, true);

        const resizedViewport = viewport.name === 'desktop'
          ? { width: 402, height: 874 }
          : { width: 1440, height: 900 };
        await page.setViewportSize(resizedViewport);
        await page.waitForFunction(
          ({ width, height }) => {
            const canvas = document.querySelector('[data-testid="game-fallback-canvas"]');
            return canvas?.width === width && canvas?.height === height;
          },
          resizedViewport,
        );
        await page.waitForTimeout(2_800);
        await inspectRenderedScene(page, `${viewport.name} resized to ${resizedViewport.width}x${resizedViewport.height}`, true);

        await page.getByTestId('button-restart').click();
        await page.waitForFunction(
          () => document.querySelector('[data-testid="text-score"]')?.textContent === '00',
        );
        await page.waitForTimeout(250);
        await inspectRenderedScene(page, `${viewport.name} after restart`, false);
      } finally {
        await context.close();
      }
    });
  }

  it('keeps gameplay controls visible on short portrait and landscape phones', async () => {
    for (const viewport of [
      { name: 'short portrait', width: 360, height: 640 },
      { name: 'phone landscape', width: 844, height: 390 },
    ]) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      try {
        await startRun(page);
        await assertPhoneControlsFit(page, viewport.name);
      } finally {
        await context.close();
      }
    }
  });
});
