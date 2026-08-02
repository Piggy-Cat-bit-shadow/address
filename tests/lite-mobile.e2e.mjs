import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const outputRoot = resolve(root, 'test-results/lite-mobile');
const port = 4322;
const baseUrl = `http://127.0.0.1:${port}`;

const indexPayload = {
  schemaVersion: 1,
  generatedAt: '2026-08-02T00:00:00.000Z',
  maxAddressesPerPostcode: 3,
  totalAddresses: 1,
  countries: [{
    code: 'US', name: 'United States', nameZh: '美国',
    targets: [{
      id: 'US-DE', label: 'Delaware', labelZh: '特拉华州', category: 'low_tax', scope: 'region',
      file: '/data/US/DE.json', note: '', maxAddresses: 24, addresses: 1, postcodes: 1,
      tax: { type: 'tax_free', rate: '≈ 0%', label: 'Sales Tax', note: 'A deliberately long tax note that must wrap safely on a phone viewport.', noteZh: '用于验证手机端自动换行的较长税务说明。' }
    }]
  }]
};

const targetPayload = {
  schemaVersion: 1,
  generatedAt: '2026-08-02T00:00:00.000Z',
  country: 'US',
  target: indexPayload.countries[0].targets[0],
  stats: { addresses: 1, postcodes: 1 },
  regions: [{ name: 'DE', cities: [{ name: 'BRIDGEVILLE', postcodes: [{ postcode: '19933', addresses: [{
    id: 'mobile-regression-address', region: 'Delaware', regionCode: 'DE', city: 'BRIDGEVILLE', locality: 'BRIDGEVILLE', postalLocality: '', district: '',
    postcode: '19933', street: 'EXTRAORDINARILY LONG RESIDENTIAL BOULEVARD NAME FOR WRAPPING', houseNumber: '103', buildingName: '', unit: '',
    latitude: 38.742001, longitude: -75.604001, propertyType: 'residential', residentialEvidence: true, qualityScore: 0.98,
    formattedAddress: 'unused', formattedAddressEn: 'unused', formattedAddressZh: 'unused',
    source: { name: 'Overture Maps addresses', url: 'https://overturemaps.org/', license: 'mixed-open', licenseUrl: '', attribution: 'Overture Maps Foundation', attributionUrl: 'https://overturemaps.org/', datasetVersion: 'test', sourceRecordId: 'test-1' }
  }] }] }] }]
};

const waitForServer = async () => {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/zh-CN/`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error('Astro preview did not become ready');
};

const contrastRatio = (foreground, background) => {
  const parse = (value) => value.match(/\d+(?:\.\d+)?/gu).slice(0, 3).map(Number);
  const luminance = (value) => {
    const rgb = parse(value).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const left = luminance(foreground);
  const right = luminance(background);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
};

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const server = spawn(resolve(root, 'node_modules/.bin/astro'), ['preview', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

const browser = await chromium.launch({ headless: true });
const failures = [];
try {
  await waitForServer();
  for (const viewport of [{ width: 390, height: 844 }, { width: 430, height: 932 }]) {
    for (const colorScheme of ['light', 'dark']) {
      const name = `${viewport.width}x${viewport.height}-${colorScheme}`;
      const context = await browser.newContext({ viewport, colorScheme, permissions: ['clipboard-read', 'clipboard-write'] });
      await context.tracing.start({ screenshots: true, snapshots: true });
      const page = await context.newPage();
      try {
        await page.route('**/data/countries.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(indexPayload) }));
        await page.route('**/data/US/DE.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(targetPayload) }));
        await page.goto(`${baseUrl}/zh-CN/`, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: '随机生成地址' }).waitFor();
        const before = await page.evaluate(() => {
          const card = document.querySelector('.lite-controls');
          const hero = document.querySelector('.lite-hero');
          const selects = [...document.querySelectorAll('select')];
          const buttons = [...document.querySelectorAll('button')];
          const tax = document.querySelector('.lite-tax');
          const bodyStyle = getComputedStyle(document.body);
          return {
            viewport: { width: innerWidth, height: innerHeight },
            scrollWidth: document.documentElement.scrollWidth,
            cardTop: card.getBoundingClientRect().top,
            heroHeight: hero.getBoundingClientRect().height,
            selectsInside: selects.every((element) => element.getBoundingClientRect().left >= 0 && element.getBoundingClientRect().right <= innerWidth),
            buttonsInside: buttons.every((element) => element.getBoundingClientRect().left >= 0 && element.getBoundingClientRect().right <= innerWidth),
            taxInside: tax.scrollWidth <= tax.clientWidth,
            labelledSelects: document.querySelectorAll('label select').length === selects.length,
            buttonNames: buttons.every((element) => Boolean(element.getAttribute('aria-label') || element.textContent.trim())),
            bodyColor: bodyStyle.color,
            bodyBackground: bodyStyle.backgroundColor,
            cardColor: getComputedStyle(card).color,
            cardBackground: getComputedStyle(card).backgroundColor
          };
        });
        if (before.scrollWidth > viewport.width) throw new Error(`horizontal overflow before result: ${before.scrollWidth}`);
        if (before.cardTop > 180 || before.heroHeight > 140) throw new Error(`mobile hero is too tall: cardTop=${before.cardTop} hero=${before.heroHeight}`);
        if (!before.selectsInside || !before.buttonsInside || !before.taxInside) throw new Error('control or tax content escapes viewport');
        if (!before.labelledSelects || !before.buttonNames) throw new Error('basic accessible names or labels are missing');
        if (contrastRatio(before.bodyColor, before.bodyBackground) < 4.5 || contrastRatio(before.cardColor, before.cardBackground) < 4.5) {
          throw new Error('body or card text contrast is below 4.5:1');
        }
        await page.getByRole('button', { name: '随机生成地址' }).click();
        await page.getByRole('heading', { level: 2 }).waitFor();
        const result = await page.evaluate(() => {
          const card = document.querySelector('.lite-result');
          const heading = document.querySelector('.lite-address-heading');
          const footer = document.querySelector('.lite-result footer');
          const tax = document.querySelector('.lite-tax');
          return {
            scrollWidth: document.documentElement.scrollWidth,
            cardInside: card.getBoundingClientRect().left >= 0 && card.getBoundingClientRect().right <= innerWidth && card.scrollWidth <= card.clientWidth,
            headingWraps: heading.scrollWidth <= heading.clientWidth && heading.querySelector('h2').getBoundingClientRect().height > 30,
            footerInside: footer.scrollWidth <= footer.clientWidth,
            taxInside: tax.scrollWidth <= tax.clientWidth
          };
        });
        if (result.scrollWidth > viewport.width || !result.cardInside || !result.headingWraps || !result.footerInside || !result.taxInside) {
          throw new Error(`result layout overflow: ${JSON.stringify(result)}`);
        }
        await page.getByRole('button', { name: '复制' }).click();
        await page.getByRole('button', { name: '已复制' }).waitFor();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        if (!copied.includes('\n') || !copied.includes('United States') && !copied.includes('美国')) throw new Error('copy interaction did not produce a structured mailing address');
        const assets = await page.evaluate(async () => {
          const urls = ['/manifest.webmanifest', '/apple-touch-icon.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/favicon.svg'];
          return Promise.all(urls.map(async (url) => ({ url, status: (await fetch(url)).status })));
        });
        if (assets.some((asset) => asset.status !== 200)) throw new Error(`PWA asset failure: ${JSON.stringify(assets)}`);
        await context.tracing.stop();
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
        await page.screenshot({ path: resolve(outputRoot, `${name}.png`), fullPage: true });
        await context.tracing.stop({ path: resolve(outputRoot, `${name}.zip`) });
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.kill('SIGTERM');
}

if (failures.length) {
  console.error(failures.join('\n'));
  console.error(serverLog);
  process.exitCode = 1;
} else {
  console.log('Address Lite mobile browser regression passed (390x844 and 430x932, light and dark).');
}
