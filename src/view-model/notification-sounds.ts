import type { NotificationSound } from "../core/notify";

/**
 * Settings labels for each `notificationSound` value, in picker order. Typed
 * against `NotificationSound`, so adding a value to `NOTIFICATION_SOUNDS`
 * without a label fails the typecheck.
 */
export const NOTIFICATION_SOUND_LABELS: Readonly<Record<NotificationSound, string>> = {
  pacer: "Pacer drop",
  default: "System default",
  off: "Off",
  basso: "Basso",
  blow: "Blow",
  bottle: "Bottle",
  frog: "Frog",
  funk: "Funk",
  glass: "Glass",
  hero: "Hero",
  morse: "Morse",
  ping: "Ping",
  pop: "Pop",
  purr: "Purr",
  sosumi: "Sosumi",
  submarine: "Submarine",
  tink: "Tink",
};

/** Picker options, in the order of `NOTIFICATION_SOUND_LABELS`. */
export const notificationSoundOptions = (): { value: NotificationSound; label: string }[] =>
  (Object.entries(NOTIFICATION_SOUND_LABELS) as [NotificationSound, string][]).map(([value, label]) => ({ value, label }));
