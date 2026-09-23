import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  expect: { timeout: 10000 },
  workers: 1,
  use: {
    baseURL: process.env.QOR_E2E_URL || 'http://127.0.0.1:18080',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  reporter: 'list',
});
