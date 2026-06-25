import { test, expect, chromium } from '@playwright/test';

const BASE_URL = 'http://localhost:3000';

test('FictionFlow chat: send halo, navigate back, and verify persistence', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(BASE_URL);
  await page.waitForTimeout(1000);

  // Click the first story session if available
  const sessionLinks = await page.locator('a[href^="/story.html?id="]').all();
  if (sessionLinks.length === 0) {
    throw new Error('No story sessions found on home page');
  }
  await sessionLinks[0].click();
  await page.waitForTimeout(1500);

  // Find the chat input and send "halo"
  const input = page.locator('#messageInput');
  await input.waitFor();
  await input.fill('halo');
  await input.press('Enter');

  // Wait for AI response
  await page.waitForTimeout(8000);

  // Verify user message exists
  const userMessages = await page.locator('.msg-content:has-text("halo")').count();
  expect(userMessages).toBeGreaterThan(0);

  // Verify AI response exists (look for a non-empty AI bubble)
  const aiMessages = await page.locator('.msg-content').count();
  expect(aiMessages).toBeGreaterThan(1);

  // Navigate back to home
  await page.goBack();
  await page.waitForTimeout(1000);

  // Reopen the same session
  await sessionLinks[0].click();
  await page.waitForTimeout(2000);

  // Verify messages persisted
  const persistedUserMessages = await page.locator('.msg-content:has-text("halo")').count();
  expect(persistedUserMessages).toBeGreaterThan(0);

  const persistedAiMessages = await page.locator('.msg-content').count();
  expect(persistedAiMessages).toBeGreaterThan(1);

  await browser.close();
});
