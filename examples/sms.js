// One function for sending SMS in your app. Locally it goes to otp-sandbox; in production to your provider.
// .env (local):       SMS_DRIVER=sandbox   SMS_SANDBOX_URL=http://localhost:4010
// .env (production):  SMS_DRIVER=provider  plus your provider's credentials

export async function sendSms({ to, message, templateId, sender = 'ACMEIN' }) {
  if (process.env.SMS_DRIVER === 'sandbox') {
    const base = process.env.SMS_SANDBOX_URL || 'http://localhost:4010';
    const res = await fetch(`${base}/api/sms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, message, template_id: templateId, sender }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error); // e.g. "Blocked by DLT check: ..."
    return data;
  }
  // Call your real provider here (MSG91, Twilio, Gupshup, Exotel...), passing the same DLT template ID.
  throw new Error('Configure your SMS provider');
}
