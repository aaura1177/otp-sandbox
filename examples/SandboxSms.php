<?php

// Laravel: send SMS to otp-sandbox in local/dev, to your provider in production.
// .env (local): SMS_DRIVER=sandbox  SMS_SANDBOX_URL=http://localhost:4010
// config/services.php: 'sms' => ['driver' => env('SMS_DRIVER', 'provider'), 'sandbox_url' => env('SMS_SANDBOX_URL')]

namespace App\Services;

use Illuminate\Support\Facades\Http;
use RuntimeException;

class Sms
{
    public function send(string $to, string $message, string $templateId, string $sender = 'ACMEIN'): array
    {
        if (config('services.sms.driver') === 'sandbox') {
            $response = Http::post(rtrim(config('services.sms.sandbox_url'), '/').'/api/sms', [
                'to' => $to,
                'message' => $message,
                'template_id' => $templateId,
                'sender' => $sender,
            ]);
            if ($response->failed()) {
                throw new RuntimeException($response->json('error', 'SMS sandbox error'));
            }

            return $response->json();
        }

        // Call your real provider here with the same DLT template ID.
        throw new RuntimeException('Configure your SMS provider');
    }
}
