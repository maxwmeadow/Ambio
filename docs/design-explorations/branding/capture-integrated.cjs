const { chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');

const brandingDir = path.join(__dirname);
const artifactDir = 'C:\\Users\\maxst\\.gemini\\antigravity\\brain\\c75af63c-7f54-4b57-b95c-e2402bfc947e';

async function main() {
  console.log('Launching browser (msedge)...');
  const browser = await chromium.launch({ channel: 'msedge' });
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    viewport: { width: 1440, height: 1200 }
  });
  const page = await context.newPage();

  const fileUrl = 'file:///' + path.join(brandingDir, 'integrated-a-study.html').replace(/\\/g, '/');
  console.log('Navigating to:', fileUrl);
  await page.goto(fileUrl);
  await page.waitForTimeout(1000); // Allow web fonts to load

  const sections = [
    { id: '#section-integrated-lower', name: 'review-integrated-lower.png' },
    { id: '#section-integrated-caps', name: 'review-integrated-caps.png' }
  ];

  for (const { id, name } of sections) {
    const el = await page.$(id);
    if (el) {
      const destPath1 = path.join(brandingDir, name);
      const destPath2 = path.join(artifactDir, name);
      await el.screenshot({ path: destPath1 });
      fs.copyFileSync(destPath1, destPath2);
      console.log(`Captured ${name}`);
    } else {
      console.warn(`Element ${id} not found`);
    }
  }

  await browser.close();
  console.log('All integrated A sections captured successfully!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
