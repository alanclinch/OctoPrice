# Notifications

## What gets sent

Two kinds, each switchable independently in Settings.

### Tomorrow's prices are published

Sent once, when a **complete** day for tomorrow has been retrieved.

```text
Octopus Agile prices for 2026-08-27 are available

Cheapest: 21.1p/kWh at 02:30
Most expensive: 45.3p/kWh at 18:30
Average: 27.9p/kWh
4 periods match Cheap electricity
```

Opening it deep-links to `/?date=<tomorrow>`, which the app opens on the
Tomorrow tab.

### A rule matched

One notification per matching stretch, not per half hour.

```text
Two cheap hours

01:00 to 03:00 (2 hours)
Average 5p/kWh, low of 4p/kWh
Price <= 7p for at least 2 hours
```

## Duplicate prevention

This is the part that matters (DESIGN.md sections 20 and 21). The poller runs
every five minutes and the server may restart at any time, so "send when the
rule matches" would nag endlessly.

Every payload carries a `dedupeKey` built only from stable facts:

```text
daily:  {user}:daily_prices:{pricingDate}
rule:   {user}:rule:{ruleId}:{pricingDate}:{runStartUtc}:{periodCount}
```

`NotificationService.deliver` checks the key against `notification_log` and
returns early if it has already been **sent**. The key is written as `sent`
only after at least one device accepted the message.

The consequences, all covered by tests:

- Polling the same day repeatedly sends nothing further.
- Restarting the server sends nothing further.
- A send that failed can be retried later, because failure does not claim the
  key.
- If Octopus republishes a corrected price that lengthens a cheap window, the
  run start or period count changes, so the key changes and the user is told.
- An unrelated price change elsewhere in the day does not change the key.

Including the period count in the key is a deliberate trade-off: it catches
genuine changes to a matched stretch, at the cost of a second notification if
a window grows. Silence about a real change seemed the worse failure.

## Transports

Delivery sits behind `NotificationSender`:

```ts
interface NotificationSender {
  readonly provider: NotificationProvider;
  readonly available: boolean;
  send(payload: NotificationPayload, targets: readonly DeliveryTarget[]): Promise<DeliveryResult[]>;
}
```

Only `WebPushSender` exists today. Telegram, ntfy, email, Discord, Pushover
and Home Assistant are all named in the provider enum and should be added as
further implementations — the price-monitoring engine should never learn that
they exist.

## Web Push setup

1. Generate a key pair:

   ```bash
   npm run generate:vapid
   ```

2. Put `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` in `.env`.
3. Restart the server.
4. Open the app, go to Settings, and turn on notifications for that device.

Each device holds its own subscription, so a phone, a tablet and a PC each
need turning on separately. Permission is only ever requested in response to
the button being pressed.

Regenerating the VAPID pair invalidates every existing subscription and
everyone has to re-enable notifications.

### Requirements

- **HTTPS**, or `localhost`. Push will not work over plain HTTP on a LAN
  address; see `deployment.md`.
- On Android, install the PWA to the home screen for the most reliable
  delivery.
- iOS supports web push only for apps added to the home screen, on recent
  versions.

### Expired subscriptions

When a push service replies 404 or 410 the device is gone for good — the app
was uninstalled, or the subscription was revoked. That subscription is
disabled rather than retried forever, and logged as `SUBSCRIPTION_EXPIRED`.

## Privacy

A push subscription contains everything needed to send messages to a device,
so it is treated as a secret:

- Never logged. `logger.ts` redacts `subscription`, `endpoint`, `keys`,
  `p256dh` and `auth` at any nesting depth.
- Never echoed back by the API. `POST /api/push/subscribe` returns an id, and
  `GET /api/push/subscriptions` returns a count.

## Log events

| Event                   | Meaning                                     |
| ----------------------- | ------------------------------------------- |
| `RULE_MATCH`            | A rule matched a stretch of periods         |
| `NOTIFICATION_SENT`     | Delivered to at least one device            |
| `NOTIFICATION_SKIPPED`  | Suppressed as a duplicate                   |
| `NOTIFICATION_FAILED`   | No device accepted it                       |
| `SUBSCRIPTION_EXPIRED`  | A device subscription was disabled          |

## Current status

Web push is implemented and unit tested with a recording sender, but has
**not yet been verified against a real device**. The embedded browser used
during development refuses service worker registration, so the end-to-end
path — real service worker, real push service, real phone — is the main thing
still to confirm.
