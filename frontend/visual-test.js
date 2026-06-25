import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'http://localhost:3000';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT_DIR = path.join(process.cwd(), 'test-screenshots');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.error('PAGE ERROR:', err.message));

  const delay = (ms) => page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), ms);

  try {
    console.log('1. Opening home page...');
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2' });
    await delay(1000);

    const storyCards = await page.$$('[data-open]');
    if (storyCards.length === 0) {
      console.error('No story sessions found');
      await browser.close();
      process.exit(1);
    }
    const firstStoryId = await storyCards[0].evaluate(el => el.getAttribute('data-open'));
    console.log('First story id:', firstStoryId);

    console.log('2. Opening chat page...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
      storyCards[0].click(),
    ]);
    await delay(1500);

    // Screenshot before chat
    await page.screenshot({ path: path.join(OUT_DIR, '01-chat-before.png'), fullPage: false });

    console.log('3. Sending "halo"...');
    const input = await page.waitForSelector('#messageInput');
    await input.type('halo');
    await page.keyboard.press('Enter');

    // Wait for AI response or error dialog
    await delay(10000);

    // Screenshot after chat
    await page.screenshot({ path: path.join(OUT_DIR, '02-chat-after-halo.png'), fullPage: false });

    console.log('4. Checking messages on chat page...');
    const bubbleWidths = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.msg-content')).map((el, i) => ({
        index: i,
        text: el.innerText.trim().slice(0, 30),
        width: el.getBoundingClientRect().width,
        parentWidth: el.parentElement.getBoundingClientRect().width,
        htmlClass: el.className,
      }));
    });
    console.log('Bubble widths:', bubbleWidths);

    const haloBubbles = bubbleWidths.filter(b => b.text.toLowerCase().includes('halo'));
    const tooWide = haloBubbles.some(b => b.width > 300);
    if (tooWide) {
      console.warn('WARN: a "halo" bubble is wider than 300px');
    } else {
      console.log('OK: "halo" bubbles are narrow');
    }

    // Check scroll button exists and is visible after scroll up
    const scrollBtnExists = await page.$('#scrollToBottomBtn') !== null;
    console.log('Scroll button exists:', scrollBtnExists);

    // Scroll up to test button appearance
    const chatContainer = await page.$('#chatContainer');
    if (chatContainer) {
      await page.evaluate(() => {
        const c = document.getElementById('chatContainer');
        if (c) c.scrollTop = 0;
      });
      await delay(500);
      await page.screenshot({ path: path.join(OUT_DIR, '03-scrolled-up.png'), fullPage: false });
      const scrollBtnOpacity = await page.evaluate(() => {
        const btn = document.getElementById('scrollToBottomBtn');
        return btn ? window.getComputedStyle(btn).opacity : '0';
      });
      console.log('Scroll button opacity after scroll up:', scrollBtnOpacity);
    }

    console.log('5. Navigating back to home...');
    await page.goBack();
    await page.waitForSelector('[data-open]', { timeout: 10000 });
    await delay(1000);

    console.log('6. Reopening same story...');
    const backLinks = await page.$$('[data-open]');
    if (backLinks.length === 0) {
      console.error('No story cards after returning home');
      await browser.close();
      process.exit(1);
    }
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
      backLinks[0].click(),
    ]);
    await delay(2000);
    await page.screenshot({ path: path.join(OUT_DIR, '04-persisted.png'), fullPage: false });

    console.log('7. Checking messages after navigation...');
    const persistedTexts = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.msg-content')).map(el => el.innerText.trim());
    });
    const hasHalo = persistedTexts.some(t => t.toLowerCase().includes('halo'));
    const hasAiReply = persistedTexts.length > 1;

    console.log('');
    console.log('=== TEST RESULT ===');
    console.log('User "halo" persisted:', hasHalo ? 'YES' : 'NO');
    console.log('AI reply persisted:', hasAiReply ? 'YES' : 'NO');
    console.log('Overall:', hasHalo && hasAiReply ? 'PASS' : 'FAIL');
    console.log('Screenshots saved to:', OUT_DIR);

    await delay(3000);
  } catch (err) {
    console.error('Test error:', err);
    await page.screenshot({ path: path.join(OUT_DIR, 'error-screenshot.png'), fullPage: false });
  } finally {
    await browser.close();
  }
})();
