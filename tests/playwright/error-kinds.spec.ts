// Produces one failure of each kind the script generator's classifier must tell apart.
// Run by tests/script-generator/playwright-errors.test.ts; its output is recorded in
// tests/fixtures/playwright-errors/<version>.json.
import { expect, test } from '@playwright/test';

const html = `
  <p id="msg">Password incorrect</p>
  <button>Save</button><button>Save</button>
  <p id="hidden" style="display:none">Hidden</p>
  <ul><li>a</li><li>b</li></ul>`;

test.beforeEach(async ({ page }) => {
  await page.setContent(html);
});

test('value-mismatch-toBe', async () => {
  expect(200, 'E1').toBe(400);
});

test('value-mismatch-toEqual', async () => {
  expect({ ok: true }, 'E1').toEqual({ ok: false });
});

test('value-mismatch-toContain', async () => {
  expect('Your order was placed', 'E1').toContain('cancelled');
});

test('value-mismatch-toHaveText', async ({ page }) => {
  await expect(page.locator('#msg'), 'E2').toHaveText('Password Incorrect', { timeout: 1000 });
});

test('value-mismatch-toHaveURL', async ({ page }) => {
  await expect(page, 'E3').toHaveURL('http://localhost:8080/login', { timeout: 1000 });
});

test('value-mismatch-toHaveCount', async ({ page }) => {
  await expect(page.locator('li'), 'E4').toHaveCount(3, { timeout: 1000 });
});

test('not-found-with-value', async ({ page }) => {
  await expect(page.getByRole('alert'), 'E5').toHaveText('Saved', { timeout: 1000 });
});

test('strict-mode-with-value', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Save' }), 'E6').toHaveText('Save', { timeout: 1000 });
});

test('value-less-hidden', async ({ page }) => {
  await expect(page.locator('#hidden'), 'E7').toBeVisible({ timeout: 1000 });
});

test('value-less-not-found', async ({ page }) => {
  await expect(page.getByText('Order placed'), 'E8').toBeVisible({ timeout: 1000 });
});

test('type-error', async () => {
  const body = undefined as unknown as { user: { id: string } };
  expect(body.user.id, 'E9').toBe('x');
});

test('action-timeout', async ({ page }) => {
  await page.getByRole('button', { name: 'Checkout' }).click({ timeout: 1000 });
});

test('test-timeout', async () => {
  test.setTimeout(1500);
  await new Promise(() => {});
});

test('connection-refused', async ({ request }) => {
  await request.get('http://127.0.0.1:1/api/items');
});
