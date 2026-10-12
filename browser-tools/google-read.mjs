// Usage: node /root/browser-tools/google-read.mjs "query"  — prints title|url per SERP result
import { chromium } from 'patchright';
const q = process.argv[2];
if (!q) { console.error('usage: google-read.mjs <query>'); process.exit(2); }
const browser = await chromium.launch({ executablePath: '/usr/local/bin/google-chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
const page = await (await browser.newContext()).newPage();
await page.goto('https://www.google.com/search?q=' + encodeURIComponent(q), { waitUntil: 'domcontentloaded', timeout: 30000 });
if (/sorry|unusual/i.test(page.url())) { console.error('BLOCKED by google'); process.exit(1); }
for (const a of await page.locator('a:has(h3)').all()) {
  const url = await a.getAttribute('href'); const title = (await a.innerText()).replace(/\n/g,' ');
  if (url?.startsWith('http')) console.log(`${title} | ${url}`);
}
await browser.close();
