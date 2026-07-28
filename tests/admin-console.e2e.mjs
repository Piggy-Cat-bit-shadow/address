import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const runtime = resolve(root, 'tmp', `admin-e2e-${process.pid}-${Date.now()}`);
if (!runtime.startsWith(`${root}\\`) && !runtime.startsWith(`${root}/`)) throw new Error('INVALID_TEST_RUNTIME');

const availablePort = async () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolvePort(port));
  });
});

const executablePath = () => [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean).find((candidate) => existsSync(candidate));

const waitForServer = async (baseUrl, server, errors) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`ADMIN_E2E_SERVER_EXITED:${errors.join('')}`);
    try { if ((await fetch(`${baseUrl}/api/v1/health`)).ok) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`ADMIN_E2E_SERVER_TIMEOUT:${errors.join('')}`);
};

const panel = (page, value) => page.locator('.admin-panel > header h2').filter({ hasText: new RegExp(`^${value}$`) });
const login = async (page, password) => {
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await panel(page, '地址数据').waitFor();
};

await mkdir(resolve(runtime, 'imports'), { recursive: true });
await writeFile(resolve(runtime, 'imports', 'area.json'), JSON.stringify([{
  code: '110000', name: '北京市', level: 'province', children: [{
    code: '110100', name: '北京市', level: 'city', children: [
      { code: '110105', name: '朝阳区', level: 'district' }
    ]
  }]
}]), 'utf8');

const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const serverErrors = [];
const server = spawn(process.execPath, ['--import', 'tsx', 'server/api/server.ts'], {
  cwd: root,
  env: {
    ...process.env,
    API_HOST: '127.0.0.1', API_PORT: String(port),
    ADDRESS_DATABASE_PATH: resolve(runtime, 'address.sqlite'), CONTROL_DATABASE_PATH: resolve(runtime, 'control.sqlite'),
    CONFIG_MASTER_KEY: '3333333333333333333333333333333333333333333333333333333333333333',
    ADMIN_BOOTSTRAP_PASSWORD: 'initial admin password', COOKIE_SECURE: 'false', STATIC_ROOT: resolve(root, 'dist'),
    ADDRESS_DATA_ROOT: runtime, ADDRESS_SYNC_CACHE_DIR: resolve(runtime, 'staging'), AMAP_API_KEY: ''
  },
  stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
});
server.stderr.on('data', (value) => serverErrors.push(String(value)));

let browser;
try {
  await waitForServer(baseUrl, server, serverErrors);
  const browserPath = executablePath();
  assert.ok(browserPath, 'Set PLAYWRIGHT_EXECUTABLE_PATH to a Chromium-compatible browser');
  browser = await chromium.launch({ headless: true, executablePath: browserPath });
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const pageErrors = [];
  context.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));

  const loginPage = await context.newPage();
  await loginPage.goto(`${baseUrl}/admin/`);
  await loginPage.locator('input[type=password]').fill('wrong administrator password');
  await loginPage.getByRole('button', { name: '登录', exact: true }).click();
  await loginPage.locator('.admin-error').filter({ hasText: '管理员密码错误' }).waitFor();
  await login(loginPage, 'initial admin password');

  const page = await context.newPage();
  await page.goto(`${baseUrl}/admin/`);
  await panel(page, '地址数据').waitFor();
  assert.equal(await page.locator('.admin-content > header.admin-topbar').count(), 1);
  assert.equal(await page.locator('.admin-content > header.admin-topbar h1').count(), 0);
  assert.equal(await page.getByRole('button', { name: '英文', exact: true }).count(), 1);
  assert.equal(await page.getByText('数据与系统管理', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '审计日志', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '系统管理', exact: true }).count(), 0);
  assert.equal(await page.locator('button.drill-button').filter({ hasText: '美国' }).isDisabled(), true);
  await page.getByRole('button', { name: '英文', exact: true }).click();
  await panel(page, 'Address data').waitFor();
  await page.getByRole('button', { name: 'Chinese', exact: true }).click();
  await panel(page, '地址数据').waitFor();

  const views = [
    ['仪表盘', '地址数据'], ['同步策略', '地址数量与并发'], ['地址黑名单', '地址黑名单'], ['访问与安全', '访问策略'], ['地图密钥', '地图密钥'],
    ['中国同步', '自动同步'], ['接口令牌', '接口令牌'], ['任务中心', '任务中心']
  ];
  for (let round = 0; round < 3; round += 1) {
    for (const [tab, title] of views) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      await panel(page, title).waitFor();
    }
  }

  await page.getByRole('button', { name: '同步策略', exact: true }).click();
  assert.equal(await page.getByText('内置排除规则', { exact: true }).count(), 0);
  await page.locator('.policy-runtime-form input').nth(0).fill('4');
  await page.locator('.policy-runtime-form input').nth(1).fill('2');
  await page.getByRole('button', { name: '保存并发设置', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '并发设置已保存' }).waitFor();
  const usPolicyRow = page.locator('tbody tr').filter({ hasText: /美国.*US/s }).first();
  await usPolicyRow.getByRole('button', { name: '修改策略', exact: true }).click();
  const policyDialog = page.getByRole('dialog', { name: '修改策略' });
  await policyDialog.locator('input[name=targetCount]').fill('12345');
  await policyDialog.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '同步策略已保存' }).waitFor();
  await usPolicyRow.getByRole('button', { name: '管理区域', exact: true }).click();
  await page.locator('.admin-empty').filter({ hasText: '当前层级暂无行政节点' }).waitFor();
  await page.getByRole('button', { name: '返回国家', exact: true }).click();

  await page.getByRole('button', { name: '地址黑名单', exact: true }).click();
  await page.getByText('内置排除规则', { exact: true }).waitFor();
  await page.locator('.blacklist-settings textarea').fill('测试机构\n测试园区');
  await page.getByRole('button', { name: '保存黑名单', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '地址黑名单已保存' }).waitFor();

  await page.getByRole('button', { name: '访问与安全', exact: true }).click();
  await page.locator('input[name=frontendPasswordEnabled]').check();
  await page.getByRole('button', { name: '修改前端密码', exact: true }).click();
  const frontendPasswordDialog = page.getByRole('dialog', { name: '修改前端密码' });
  await frontendPasswordDialog.locator('input[name=password]').fill('new frontend password');
  await frontendPasswordDialog.locator('input[name=confirmation]').fill('mismatched frontend password');
  await frontendPasswordDialog.getByRole('button', { name: '保存密码', exact: true }).click();
  await page.locator('.field-error').filter({ hasText: '两次输入的密码不一致' }).waitFor();
  await frontendPasswordDialog.locator('input[name=confirmation]').fill('new frontend password');
  await frontendPasswordDialog.getByRole('button', { name: '显示', exact: true }).first().click();
  assert.equal(await frontendPasswordDialog.locator('input[name=password]').getAttribute('type'), 'text');
  await frontendPasswordDialog.getByRole('button', { name: '隐藏', exact: true }).first().click();
  await frontendPasswordDialog.getByRole('button', { name: '保存密码', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '访问设置已保存' }).waitFor();
  await page.getByRole('button', { name: '修改管理员密码', exact: true }).click();
  const adminPasswordDialog = page.getByRole('dialog', { name: '修改管理员密码' });
  await adminPasswordDialog.locator('input[name=password]').fill('new administrator password');
  await adminPasswordDialog.locator('input[name=confirmation]').fill('new administrator password');
  await adminPasswordDialog.getByRole('button', { name: '保存密码', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '访问设置已保存' }).waitFor();
  assert.equal(await page.locator('input[name=frontendPasswordEnabled]').isChecked(), true);

  await page.getByRole('button', { name: '地图密钥', exact: true }).click();
  assert.equal(await page.locator('input[name=googleChina]').isChecked(), true);
  assert.equal(await page.locator('input[name=googleInternational]').isChecked(), true);
  assert.equal(await page.locator('input[name=amapChina]').isChecked(), false);
  assert.equal(await page.locator('input[name=amapInternational]').isChecked(), false);
  await page.getByRole('button', { name: '+ 配置密钥', exact: true }).click();
  const browserMapDialog = page.getByRole('dialog', { name: '配置高德地图浏览器密钥' });
  await browserMapDialog.locator('input[name=label]').fill('e2e-browser-map');
  await browserMapDialog.locator('input[name=apiKey]').fill('e2e-public-browser-key');
  await browserMapDialog.locator('input[name=securityCode]').fill('e2e-private-security-code');
  await browserMapDialog.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '高德地图浏览器密钥已保存' }).waitFor();
  assert.equal((await page.locator('body').textContent()).includes('e2e-public-browser-key'), false);
  assert.equal((await page.locator('body').textContent()).includes('e2e-private-security-code'), false);
  const browserKeyCell = page.locator('.credential-summary > div').filter({ hasText: '浏览器接口密钥' });
  await browserKeyCell.getByRole('button', { name: '显示', exact: true }).click();
  await browserKeyCell.getByText('e2e-public-browser-key', { exact: true }).waitFor();
  await browserKeyCell.getByRole('button', { name: '复制', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'e2e-public-browser-key');
  await browserKeyCell.getByRole('button', { name: '隐藏', exact: true }).click();
  assert.equal(await browserKeyCell.getByText('e2e-public-browser-key', { exact: true }).count(), 0);
  const browserCodeCell = page.locator('.credential-summary > div').filter({ hasText: '安全密钥' });
  await browserCodeCell.getByRole('button', { name: '显示', exact: true }).click();
  await browserCodeCell.getByText('e2e-private-security-code', { exact: true }).waitFor();
  await browserCodeCell.getByRole('button', { name: '隐藏', exact: true }).click();
  await page.locator('label.switch-field:has(input[name=googleChina]) span').click();
  await page.locator('label.switch-field:has(input[name=amapChina]) span').click();
  assert.equal(await page.locator('input[name=googleChina]').isChecked(), false);
  assert.equal(await page.locator('input[name=amapChina]').isChecked(), true);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '地图显示设置已保存' }).waitFor();
  const frontendMapLogin = await page.evaluate(async () => {
    const response = await fetch('/web-api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'new frontend password' })
    });
    return response.status;
  });
  assert.equal(frontendMapLogin, 200);
  const mapConfiguration = await page.evaluate(async () => (await (await fetch('/web-api/v1/config/maps?country=CN')).json()).data);
  assert.deepEqual(mapConfiguration, {
    countryCode: 'CN', googleEnabled: false, amapEnabled: true, amapConfigured: true,
    amapApiKey: 'e2e-public-browser-key', serviceHost: '/_AMapService'
  });
  assert.equal(JSON.stringify(mapConfiguration).includes('e2e-private-security-code'), false);
  await page.getByRole('button', { name: '+ 添加密钥', exact: true }).click();
  const keyDialog = page.getByRole('dialog', { name: '添加地图密钥' });
  await keyDialog.waitFor();
  assert.equal(await keyDialog.getByText('QPS', { exact: true }).count(), 0);
  assert.equal(await keyDialog.getByText('每日额度', { exact: true }).count(), 0);
  assert.equal(await keyDialog.getByText('共享配额组', { exact: true }).count(), 0);
  await keyDialog.locator('input[name=label]').fill('e2e-amap');
  await keyDialog.locator('input[name=secret]').fill('fake-key-for-e2e');
  await keyDialog.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '地图密钥已保存' }).waitFor();
  const providerRow = () => page.locator('tbody tr').filter({ hasText: 'e2e-amap' });
  await providerRow().waitFor();
  await providerRow().getByText('每月', { exact: false }).waitFor();
  await providerRow().getByText('0 / 5,000', { exact: true }).waitFor();
  await providerRow().getByText('本地统计', { exact: false }).waitFor();
  assert.equal((await providerRow().textContent()).includes('fake-key-for-e2e'), false);
  const providerSecretCell = providerRow().locator('.secret-cell');
  await providerSecretCell.getByRole('button', { name: '显示', exact: true }).click();
  await providerSecretCell.getByText('fake-key-for-e2e', { exact: true }).waitFor();
  await page.getByRole('button', { name: '仪表盘', exact: true }).click();
  await page.getByRole('button', { name: '地图密钥', exact: true }).click();
  await providerRow().waitFor();
  assert.equal((await providerRow().textContent()).includes('fake-key-for-e2e'), false);
  await providerRow().getByRole('button', { name: '停用', exact: true }).click();
  await providerRow().getByRole('button', { name: '启用', exact: true }).waitFor();
  await providerRow().getByRole('button', { name: '启用', exact: true }).click();
  await providerRow().getByRole('button', { name: '停用', exact: true }).waitFor();

  await page.getByRole('button', { name: '接口令牌', exact: true }).click();
  await page.getByRole('button', { name: '英文', exact: true }).click();
  await panel(page, 'API tokens').waitFor();
  await page.getByRole('button', { name: 'Chinese', exact: true }).click();
  await panel(page, '接口令牌').waitFor();
  assert.equal(await page.getByRole('columnheader', { name: '前缀', exact: true }).count(), 0);
  assert.equal(await page.getByRole('columnheader', { name: '最近使用', exact: true }).count(), 0);
  assert.equal(await page.getByRole('columnheader', { name: '状态', exact: true }).count(), 0);
  await page.getByRole('button', { name: '+ 添加令牌', exact: true }).click();
  const tokenDialog = page.getByRole('dialog', { name: '添加接口令牌' });
  await tokenDialog.locator('input[name=name]').fill('e2e-token');
  await tokenDialog.locator('input[name=rateLimit]').fill('1');
  assert.equal(await tokenDialog.getByRole('checkbox', { name: '全部', exact: true }).isChecked(), true);
  await tokenDialog.getByRole('button', { name: '生成令牌', exact: true }).click();
  const token = await tokenDialog.locator('input[name=token]').inputValue();
  assert.match(token, /^addr_[A-Za-z0-9_-]+$/u);
  await tokenDialog.getByRole('button', { name: '创建', exact: true }).click();
  const createdTokenDialog = page.getByRole('dialog', { name: '令牌已创建' });
  await createdTokenDialog.getByText(token, { exact: true }).waitFor();
  await createdTokenDialog.getByRole('button', { name: '复制', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), token);
  await createdTokenDialog.getByRole('button', { name: '关闭', exact: true }).last().click();
  const tokenRow = page.locator('tbody tr').filter({ hasText: 'e2e-token' });
  await tokenRow.waitFor();
  assert.equal((await tokenRow.textContent()).includes(token), false);
  await tokenRow.getByRole('button', { name: '显示', exact: true }).click();
  await tokenRow.getByText(token, { exact: true }).waitFor();
  await tokenRow.getByRole('button', { name: '隐藏', exact: true }).click();
  assert.equal(await page.evaluate(async () => (await fetch('/api/v1/countries')).status), 401);
  assert.equal(await page.evaluate(async (value) => (await fetch('/api/v1/countries', { headers: { Authorization: `Bearer ${value}` } })).status, token), 200);
  assert.equal(await page.evaluate(async (value) => (await fetch('/api/v1/countries', { headers: { Authorization: `Bearer ${value}` } })).status, token), 429);
  await tokenRow.getByRole('button', { name: '编辑', exact: true }).click();
  const editTokenDialog = page.getByRole('dialog', { name: '修改接口令牌' });
  await editTokenDialog.getByRole('checkbox', { name: '生成', exact: true }).uncheck();
  await editTokenDialog.locator('input[name=rateLimit]').fill('5');
  await editTokenDialog.locator('input[name=expiresAt]').fill('2099-12-31T23:59');
  await editTokenDialog.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '令牌设置已更新' }).waitFor();
  await tokenRow.filter({ hasText: '读取' }).waitFor();
  assert.equal(await page.evaluate(async (value) => (await fetch('/api/v1/generate', { headers: { Authorization: `Bearer ${value}` } })).status, token), 401);
  assert.equal(await page.evaluate(async (value) => (await fetch('/api/v1/countries', { headers: { Authorization: `Bearer ${value}` } })).status, token), 200);
  page.once('dialog', (dialog) => dialog.accept());
  await tokenRow.getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal(await page.evaluate(async (value) => (await fetch('/api/v1/countries', { headers: { Authorization: `Bearer ${value}` } })).status, token), 401);

  const importStatus = await page.evaluate(async () => {
    const csrf = document.cookie.split('; ').find((value) => value.startsWith('address_admin_csrf='))?.split('=')[1] || '';
    return (await fetch('/admin/api/china/areacity', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ source: 'imports/area.json', version: 'e2e-fixture-v1' }) })).status;
  });
  assert.equal(importStatus, 200);

  await page.getByRole('button', { name: '仪表盘', exact: true }).click();
  const drill = (name) => page.locator('button.drill-button').filter({ hasText: new RegExp(`^${name}$`) });
  await drill('中国').click();
  await drill('北京市').click();
  await drill('北京市').click();
  await page.getByText('朝阳区', { exact: true }).waitFor();
  await page.getByRole('button', { name: '全部国家', exact: true }).click();
  await drill('美国').waitFor();

  await page.getByRole('button', { name: '中国同步', exact: true }).click();
  await page.getByText('系统优先为每个区县补齐 10 个合格住宅小区，完成基础覆盖后自动继续丰富数据。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '开始/继续同步', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '同步任务已提交' }).waitFor();
  await page.waitForFunction(async () => {
    const response = await fetch('/admin/api/runs', { cache: 'no-store' }); const body = await response.json();
    return ['paused_quota', 'failed', 'succeeded'].includes(body.data?.[0]?.status);
  }, undefined, { timeout: 30_000 });
  await page.getByRole('button', { name: '任务中心', exact: true }).click();
  await panel(page, '任务中心').waitFor();
  await page.locator('.admin-panel').filter({ hasText: /paused_quota|failed|succeeded/u }).waitFor({ timeout: 30_000 });

  await page.getByRole('button', { name: '地图密钥', exact: true }).click();
  await providerRow().getByRole('button', { name: '删除', exact: true }).click();
  await providerRow().waitFor({ state: 'detached' });
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.credential-summary').getByRole('button', { name: '删除', exact: true }).click();
  await page.getByText('尚未配置高德地图浏览器密钥', { exact: true }).waitFor();

  await page.getByRole('button', { name: '访问与安全', exact: true }).click();
  await page.locator('input[name=apiAuthEnabled]').uncheck();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '访问设置已保存' }).waitFor();
  assert.equal(await page.evaluate(async () => (await fetch('/api/v1/countries')).status), 200);
  await page.locator('input[name=apiAuthEnabled]').check();
  await page.locator('input[name=frontendPasswordEnabled]').uncheck();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '访问设置已保存' }).waitFor();
  const openContext = await browser.newContext();
  const openPage = await openContext.newPage();
  await openPage.goto(`${baseUrl}/`);
  assert.notEqual(new URL(openPage.url()).pathname, '/access/');
  await openContext.close();
  await page.locator('input[name=frontendPasswordEnabled]').check();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.locator('.admin-notice').filter({ hasText: '访问设置已保存' }).waitFor();

  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('heading', { name: '管理员登录', exact: true }).waitFor();
  await login(page, 'new administrator password');

  const frontendContext = await browser.newContext();
  const frontend = await frontendContext.newPage();
  frontend.on('pageerror', (error) => pageErrors.push(error.message));
  await frontend.goto(`${baseUrl}/`);
  assert.equal(new URL(frontend.url()).pathname, '/access/');
  await frontend.locator('#password').fill('wrong frontend password');
  await frontend.getByRole('button', { name: '进入', exact: true }).click();
  await frontend.locator('#error').filter({ hasText: '密码不正确' }).waitFor();
  await frontend.locator('#password').fill('new frontend password');
  await frontend.getByRole('button', { name: '进入', exact: true }).click();
  await frontend.locator('.site-shell').waitFor();
  await frontendContext.close();

  assert.deepEqual(pageErrors, []);
  console.log('admin console e2e passed');
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null) {
    const exited = new Promise((resolveExit) => server.once('exit', resolveExit));
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { await rm(runtime, { recursive: true, force: true }); break; }
    catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
}
