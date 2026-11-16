// End-to-end OTP login test with Playwright. Start otp-sandbox and your app with SMS_DRIVER=sandbox first.
import { expect, test } from '@playwright/test';

const SANDBOX = 'http://localhost:4010';
const PHONE = '9876543210';

test.beforeEach(async ({ request }) => {
  await request.delete(`${SANDBOX}/api/sms`); // start with an empty inbox
});

test('user can log in with OTP', async ({ page, request }) => {
  await page.goto('http://localhost:3000/login');
  await page.getByLabel('Mobile number').fill(PHONE);
  await page.getByRole('button', { name: 'Send OTP' }).click();

  // Wait until the app has "sent" the SMS, then read the code.
  let otp;
  await expect(async () => {
    const res = await request.get(`${SANDBOX}/api/otp/latest?to=${PHONE}`);
    expect(res.ok()).toBeTruthy();
    otp = (await res.json()).otp;
  }).toPass({ timeout: 10_000 });

  await page.getByLabel('OTP').fill(otp);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('Welcome')).toBeVisible();
});
