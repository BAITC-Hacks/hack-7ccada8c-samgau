import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs/promises';
async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Рекомендации к закупке/ })).toContainText('8');
  await expect(page.getByLabel('Режим данных')).toHaveValue('api');
}
async function onlyOne(page: Page, sku = '00001') {
  await page.getByRole('button', { name: 'Снять выбор', exact: true }).click();
  await page.getByLabel('Поиск товаров', { exact: true }).fill(sku);
  await page.locator('tbody input[type=checkbox]').check();
}
async function warningCheck(page: Page) {
  const ack = page.getByRole('checkbox', { name: /Я просмотрел предупреждения/ });
  if (await ack.count()) {
    await expect(
      page.getByRole('button', { name: 'Утвердить черновик', exact: true }),
    ).toBeDisabled();
    await ack.check();
  }
}
test('156 -> shipment scenario 204 -> reset -> PATCH 168 -> Bearer CSV; reload', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const requests: { path: string; body: any; auth: string | null }[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/'))
      requests.push({
        path: new URL(r.url()).pathname,
        body: r.postDataJSON(),
        auth: r.headers()['authorization'] || null,
      });
  });
  await ready(page);
  await page.getByLabel('Поиск товаров', { exact: true }).fill('00001');
  await expect(page.locator('tbody .order-qty')).toHaveText('156');
  await page.getByRole('button', { name: 'Что, если…', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Поставщик', { exact: true })
    .selectOption('systeme_electric');
  const option = page
    .getByLabel('Выбранная поставка', { exact: true })
    .locator('option')
    .filter({ hasText: '00001' })
    .first();
  const shipment = await option.getAttribute('value');
  expect(shipment).toBeTruthy();
  await page.getByLabel('Выбранная поставка', { exact: true }).selectOption(shipment!);
  await page.locator('#delay').focus();
  await page.locator('#delay').press('End');
  await page.getByRole('button', { name: /Сравнить сценарии/ }).click();
  await expect(page.locator('tbody .order-qty')).toHaveText('204');
  await page.getByRole('button', { name: 'Вернуть исходный' }).click();
  await expect(page.locator('tbody .order-qty')).toHaveText('156');
  await onlyOne(page);
  await page.getByRole('button', { name: /Проверить и выгрузить/ }).click();
  await page.getByLabel(/^Количество /).fill('168');
  await page.getByLabel(/^Причина изменения /).fill('Проверка интеграции 168');
  await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
  await expect(page.getByText(/версия 2 · draft/)).toBeVisible();
  await warningCheck(page);
  await page.getByRole('button', { name: 'Утвердить черновик', exact: true }).click();
  await expect(page.getByText(/Черновик утверждён/)).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Скачать CSV/ }).click();
  const file = await download;
  const csv = await fs.readFile((await file.path())!, 'utf8');
  expect(csv).toContain(';00001;');
  expect(csv).toContain(';168.0;');
  const token = await page.evaluate(() => sessionStorage.getItem('qor-bearer-session'));
  await page.reload();
  await expect(page.getByRole('heading', { name: /Рекомендации к закупке/ })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('qor-bearer-session'))).toBe(token);
  await page.getByRole('button', { name: 'Сохранённые заказы', exact: true }).click();
  await page
    .getByRole('button', { name: /approved/ })
    .first()
    .click();
  await expect(page.getByLabel(/^Количество /)).toHaveValue('168');
  await expect(page.getByLabel(/^Количество /)).toBeDisabled();
  expect(requests.filter((r) => r.path === '/api/orders' && r.body)).toHaveLength(1);
  expect(requests.find((r) => r.body?.changes)?.body.changes[0].approved_qty).toBe(168);
  expect(requests.find((r) => r.path.endsWith('/scenario'))?.body).toMatchObject({
    shipment_id: shipment,
    delay_days: 30,
  });
  expect(requests.filter((r) => r.path.startsWith('/api/runs')).every((r) => !!r.auth)).toBe(true);
  expect(requests.some((r) => r.path.includes('group:') || r.path.includes('group%3A'))).toBe(
    false,
  );
  expect(requests.filter((r) => r.path === '/api/sessions')).toHaveLength(1);
  expect(errors).toEqual([]);
});
test('cable units, blocked row, AI fallback and second session', async ({ page, browser }) => {
  await ready(page);
  await expect(
    page.locator('.inventory-legend li').filter({ hasText: 'Риск дефицита' }),
  ).toContainText('4');
  await page
    .getByLabel('Товар для графика')
    .selectOption({ label: '[ДЕМО] Кабель: метры и бухты' });
  await expect(page.locator('.chart-product > span')).toHaveText('м');
  await page.getByLabel('Поиск товаров', { exact: true }).fill('00007');
  await expect(page.locator('tbody .order-qty')).toHaveText('2');
  await expect(page.locator('tbody')).toContainText('бухта');
  await expect(page.locator('tbody')).toContainText('м');
  await page.locator('tbody .product-name').click();
  await expect(page.getByRole('dialog')).toContainText('305');
  await expect(page.getByRole('dialog')).toContainText('м/бухта');
  await page.getByRole('button', { name: 'Объяснить с помощью ИИ' }).click();
  await expect(page.getByText('Расчётное объяснение · без генерации ИИ')).toBeVisible();
  await page.getByLabel('Закрыть окно').click();
  await page.getByLabel('Поиск товаров', { exact: true }).fill('00008');
  await expect(page.locator('tbody input[type=checkbox]')).toBeDisabled();
  await expect(page.locator('tbody')).toContainText('Нет данных');
  const token = await page.evaluate(() => sessionStorage.getItem('qor-bearer-session'));
  const auth = { Authorization: `Bearer ${token}` };
  const run = await page.request.post('/api/runs', {
    headers: auth,
    data: { dataset_id: 'demo-engine-v1', supplier_id: 'iek', as_of: '2026-09-22' },
  });
  const rid = (await run.json()).run_id;
  const other = await browser.newContext();
  const second = await other.newPage();
  await ready(second);
  const token2 = await second.evaluate(() => sessionStorage.getItem('qor-bearer-session'));
  expect(token2).not.toBe(token);
  expect(
    (
      await second.request.get(`/api/runs/${rid}`, {
        headers: { Authorization: `Bearer ${token2}` },
      })
    ).status(),
  ).toBe(404);
  await other.close();
  await page.getByRole('button', { name: 'ИИ-помощник', exact: true }).click();
  await page.locator('textarea').fill('Почему заказ 00007?');
  await page.getByRole('button', { name: /Отправить/ }).click();
  await expect(page.getByText(/ИИ пока не подключён/).last()).toBeVisible();
});
test('422 keeps draft; 409 refreshes version and waits for user', async ({ page }) => {
  await ready(page);
  await onlyOne(page);
  await page.getByRole('button', { name: /Проверить и выгрузить/ }).click();
  await page.getByLabel(/^Количество /).fill('169');
  await page.getByLabel(/^Причина изменения /).fill('Проверка кратности');
  await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('MOQ');
  await page.getByLabel(/^Количество /).fill('168');
  await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
  await expect(page.getByText(/версия 2 · draft/)).toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem('qor-bearer-session'));
  const h = { Authorization: `Bearer ${token}` };
  const orders = await (await page.request.get('/api/orders', { headers: h })).json();
  expect(orders.items).toHaveLength(1);
  const d = orders.items[0];
  expect(
    (
      await page.request.patch(`/api/orders/${d.draft_id}`, {
        headers: h,
        data: {
          version: d.version,
          changes: [{ sku: '00001', approved_qty: 180, reason: 'Другая вкладка' }],
        },
      })
    ).status(),
  ).toBe(200);
  await warningCheck(page);
  await page.getByRole('button', { name: 'Утвердить черновик', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('изменён');
  await expect(page.getByText(/версия 3 · draft/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Скачать CSV/ })).toHaveCount(0);
  await warningCheck(page);
  await page.getByRole('button', { name: 'Утвердить черновик', exact: true }).click();
  await expect(page.getByText(/Черновик утверждён/)).toBeVisible();
  expect(
    (await (await page.request.get(`/api/orders/${d.draft_id}`, { headers: h })).json()).lines[0]
      .approved_qty,
  ).toBe(168);
});
for (const status of [401, 500])
  test(`HTTP ${status} does not switch to demo`, async ({ page }) => {
    await page.route('**/api/datasets', (r) =>
      r.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Тестовая ошибка сервера' } }),
      }),
    );
    await page.goto('/');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByLabel('Режим данных')).toHaveValue('api');
    await expect(page.locator('tbody tr')).toHaveCount(0);
    if (status === 401) await expect(page.getByRole('alert')).toContainText('Сессия истекла');
  });
test('mobile API view', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await page.getByLabel('Открыть меню').click();
  await page.getByRole('button', { name: 'Проверка данных', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Паспорт набора данных' })).toBeVisible();
});

test('browser imports six XLSX into its own Bearer session', async ({ page }) => {
  test.skip(
    !process.env.QOR_TEST_XLSX_DIR,
    'Provide generated XLSX directory; server uses IMPORT_ACCESS=session',
  );
  const directory = process.env.QOR_TEST_XLSX_DIR!;
  const files = (await fs.readdir(directory))
    .filter((name) => name.startsWith('iek') && name.endsWith('.xlsx'))
    .map((name) => `${directory}/${name}`);
  expect(files).toHaveLength(6);
  await ready(page);
  const token = await page.evaluate(() => sessionStorage.getItem('qor-bearer-session'));
  await page.getByRole('button', { name: 'Импорт XLSX', exact: true }).click();
  await page.getByRole('dialog').getByRole('combobox').selectOption('iek');
  await page.getByLabel('Шесть файлов XLSX').setInputFiles(files);
  await page.getByRole('button', { name: 'Загрузить и проверить', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 });
  await expect(page.getByRole('heading', { name: /Рекомендации к закупке/ })).toContainText('3');
  const dataset = await page.getByLabel('Набор данных').inputValue();
  expect(dataset).not.toBe('demo-engine-v1');
  const response = await page.request.get(`/api/datasets/${dataset}/quality`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(200);
  expect((await response.json()).source_count).toBe(6);
});

test('merged warehouse keeps canonical statuses and opens the correct product', async ({
  page,
}) => {
  await ready(page);
  const warehouse = page.getByRole('region', { name: 'Интерактивный 3D-склад' });
  await expect(warehouse).toBeVisible();
  await warehouse.getByRole('button', { name: 'Проверить данные', exact: true }).click();
  await expect(warehouse.locator('.warehouse-bin')).toHaveCount(1);
  await expect(warehouse.locator('.warehouse-inspector .warehouse-status')).toHaveText(
    'Проверить данные',
  );
  await expect(warehouse.locator('.warehouse-order dd')).toHaveText('—');
  await warehouse.getByRole('button', { name: 'Почему такой заказ?' }).click();
  await expect(page.getByRole('dialog')).toContainText('00008');
  await page.getByLabel('Закрыть окно').click();
  await warehouse.getByRole('button', { name: 'Весь склад', exact: true }).click();
  await expect(warehouse.locator('.warehouse-bin')).toHaveCount(8);
  await warehouse.getByRole('button', { name: 'Повернуть склад вправо' }).click();
  await expect(warehouse.locator('.warehouse-world')).toHaveAttribute('style', /-14deg/);
});

test('merged 1C exchange navigation, template, and assistant destination', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: 'Обмен с 1С', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Обмен с 1С', exact: true })).toBeVisible();
  await expect(page.getByLabel('Файлы выгрузок 1С')).toBeVisible();
  await expect(page.getByLabel('Ключ загрузки администратора')).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать шаблон остатков' }).click();
  const csv = await fs.readFile((await (await download).path())!, 'utf8');
  expect(csv.trim()).toBe('sku_1c;stock_unit;available_stock;as_of;warehouse_id');
  await page.getByRole('button', { name: 'ИИ-помощник', exact: true }).click();
  await page.locator('textarea').fill('Как загрузить файлы 1С?');
  await page.getByRole('button', { name: /Отправить/ }).click();
  await expect(
    page
      .getByRole('log', { name: 'История диалога' })
      .getByRole('button', { name: 'Обмен с 1С', exact: true }),
  ).toBeVisible();
});
