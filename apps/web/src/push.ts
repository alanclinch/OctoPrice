/**
 * Web Push registration.
 *
 * Each device holds its own subscription, so enabling notifications on a
 * phone does not enable them on a laptop (DESIGN.md section 11).
 *
 * Permission is only ever requested in response to the user pressing the
 * button - browsers penalise unprompted permission requests, and so do users.
 */

import { api } from './api.ts';

export type PushState = 'unsupported' | 'unconfigured' | 'denied' | 'enabled' | 'disabled';

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** The VAPID public key arrives base64url encoded; `subscribe` wants bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalised);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.ready;
}

/** The subscription this device currently holds, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  const registered = await registration();
  return (await registered?.pushManager.getSubscription()) ?? null;
}

/** Where push stands on this device right now. */
export async function pushState(): Promise<PushState> {
  if (!isPushSupported()) return 'unsupported';

  const { configured } = await api.pushKey();
  if (!configured) return 'unconfigured';

  if (Notification.permission === 'denied') return 'denied';
  return (await currentSubscription()) ? 'enabled' : 'disabled';
}

/**
 * Subscribes this device and registers it with the server.
 * Returns the resulting state so the caller can render it without re-querying.
 */
export async function enablePush(): Promise<PushState> {
  if (!isPushSupported()) return 'unsupported';

  const { publicKey, configured } = await api.pushKey();
  if (!configured || !publicKey) return 'unconfigured';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'disabled';

  const registered = await registration();
  if (!registered) return 'unsupported';

  const subscription =
    (await registered.pushManager.getSubscription()) ??
    (await registered.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    }));

  await api.subscribePush(subscription.toJSON());
  return 'enabled';
}

/** Removes this device subscription locally and on the server. */
export async function disablePush(): Promise<PushState> {
  const subscription = await currentSubscription();
  if (!subscription) return 'disabled';

  const payload = subscription.toJSON();
  await subscription.unsubscribe();
  try {
    await api.unsubscribePush(payload);
  } catch {
    // The device is unsubscribed either way; the server will drop the stale
    // record the next time a send to it fails.
  }
  return 'disabled';
}
