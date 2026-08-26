/**
 * Generates a VAPID key pair for Web Push.
 *
 * Run once per installation: `npm run generate:vapid`, then paste the two
 * values into `.env`. The private key signs push messages and must never be
 * committed or logged.
 *
 * Regenerating the pair invalidates every existing device subscription, so
 * everyone has to re-enable notifications.
 */

import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();

process.stdout.write(
  [
    'Add these to your .env file:',
    '',
    `VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `VAPID_PRIVATE_KEY=${keys.privateKey}`,
    'VAPID_SUBJECT=mailto:you@example.com',
    '',
    'Keep the private key secret. Regenerating these invalidates every',
    'device that has already subscribed to notifications.',
    '',
  ].join('\n'),
);
