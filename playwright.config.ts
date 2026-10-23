import { defineConfig } from '@playwright/test'

// Every spec launches Ambio with a HOME of its own, but Electron's user data
// and the agent config paths follow XDG_CONFIG_HOME first. GitHub's Linux
// runners set it, so one spec's dismissed introductions leaked into the next
// and the app touched the runner's real config. Unset, they fall back to the
// isolated HOME. Workers inherit this environment.
for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) delete process.env[name]

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  // Locally a flake should be visible immediately. On CI a single timing-
  // sensitive frame should not fail the run - Playwright still reports a
  // retried test as flaky rather than passing it off as clean.
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  // A missing baseline fails instead of being written next to the others,
  // so one rendered on a developer's machine is never committed by accident.
  // CI writes missing ones on purpose (--update-snapshots=missing).
  updateSnapshots: 'none',
  expect: {
    timeout: 8_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.01,
    },
  },
  use: {
    actionTimeout: 8_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // {platform} is load-bearing: text rasterization differs across operating
  // systems, so a baseline captured on one will not match another within any
  // sane pixel tolerance. Each platform keeps its own.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{platform}/{arg}{ext}',
})
