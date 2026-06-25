import puppeteer from 'puppeteer-core';

const BASE_URL = 'http://localhost:3000';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // Log console messages for debugging
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

    console.log('3. Sending "halo"...');
    const input = await page.waitForSelector('#messageInput');
    await input.type('halo');
    await page.keyboard.press('Enter');

    // Wait for AI response
    await delay(10000);

    console.log('4. Checking messages on chat page...');
    const userText = await page.evaluate(() => {
      const userBubble = document.querySelector('.msg-content');
      return userBubble ? userBubble.innerText.trim() : null;
    });
    console.log('First .msg-content text:', userText);

    const allBubbleTexts = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.msg-content')).map(el => el.innerText.trim());
    });
    console.log('All bubble texts:', allBubbleTexts);

    console.log('4b. Checking bubble widths...');
    const bubbleWidths = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.msg-content')).map((el) => ({
        text: el.innerText.trim().slice(0, 20),
        width: el.getBoundingClientRect().width,
        parentWidth: el.parentElement.getBoundingClientRect().width,
      }));
    });
    console.log('Bubble widths:', bubbleWidths);

    const haloBubbles = bubbleWidths.filter(b => b.text.toLowerCase() === 'halo');
    const tooWide = haloBubbles.some(b => b.width > 300);
    if (tooWide) {
      console.warn('WARN: a "halo" bubble is wider than 300px; width may not be shrinking to content');
    } else {
      console.log('OK: "halo" bubbles are narrow');
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

    console.log('7. Checking messages after navigation...');
    const persistedTexts = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.msg-content')).map(el => el.innerText.trim());
    });
    console.log('Persisted bubble texts:', persistedTexts);

    const hasHalo = persistedTexts.some(t => t.toLowerCase().includes('halo'));
    const hasAiReply = persistedTexts.length > 1;

    console.log('');
    console.log('=== TEST RESULT ===');
    console.log('User "halo" persisted:', hasHalo ? 'YES' : 'NO');
    console.log('AI reply persisted:', hasAiReply ? 'YES' : 'NO');
    console.log('Overall:', hasHalo && hasAiReply ? 'PASS' : 'FAIL');
  } catch (err) {
    console.error('Test error:', err);
  } finally {
    await browser.close();
  }
})();
