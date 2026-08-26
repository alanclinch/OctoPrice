/// <reference lib="webworker" />

/**
 * Service worker.
 *
 * Two jobs: cache the app shell so it opens instantly and works offline, and
 * handle push messages while the app is closed - which is the whole point of
 * the notifications (DESIGN.md section 11).
 */

import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener('install', () => {
  // Take over as soon as the new worker is ready rather than waiting for
  // every tab to close; the app is small and updates should not linger.
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
  type?: string;
  dedupeKey?: string;
}

self.addEventListener('push', (event) => {
  let payload: PushPayload;
  try {
    payload = (event.data?.json() as PushPayload) ?? {};
  } catch {
    payload = { title: 'OctoPrice', body: event.data?.text() ?? 'New price information' };
  }

  const title = payload.title ?? 'OctoPrice';
  const url = payload.url ?? '/';

  // `renotify` is part of the Notification API but missing from the DOM lib
  // types, so the option bag is widened rather than dropped.
  const options: NotificationOptions & { renotify?: boolean } = {
    body: payload.body ?? '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    // Grouping by type means a re-sent daily summary replaces the old one in
    // the tray instead of stacking up.
    tag: payload.type ?? 'octoprice',
    renotify: true,
    data: { url, dedupeKey: payload.dedupeKey },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data as { url?: string } | undefined)?.url ?? '/';

  // Focus an open window if there is one, rather than opening another copy.
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(async (clientList) => {
        for (const client of clientList) {
          if ('focus' in client) {
            await client.focus();
            if ('navigate' in client) {
              await client.navigate(target);
            }
            return;
          }
        }
        await self.clients.openWindow(target);
      }),
  );
});
