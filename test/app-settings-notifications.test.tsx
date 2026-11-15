import { expect, test } from "bun:test";
import { notificationCaption } from "../app/src/screens/settings/General";

/**
 * The Settings › Notifications "Desktop banners" row shows live state in its
 * caption, derived from doctor.run's Notifications check, and its control is
 * the check's remedy (or Send test when the check is ok). The row is
 * desktop-only and rendered through the shared SettingRow; these tests pin the
 * caption mapping for every state the doctor can report, preferring the
 * check's remedy op/url over the exact detail text.
 */
type CaptionCheck = { level: string; detail: string; remedy?: { op?: string; url?: string; caption?: string } };

const SETTINGS_URL = "x-apple.systempreferences:com.apple.Notifications-Settings.extension";

test("Desktop banners caption reads 'Not asked yet' for an undetermined permission", () => {
  const check: CaptionCheck = { level: "warn", detail: "Notification permission not asked yet", remedy: { op: "notifications.request" } };
  expect(notificationCaption(check)).toBe("Not asked yet");
});

test("Desktop banners caption reads 'Blocked in System Settings' for a denial", () => {
  const check: CaptionCheck = { level: "warn", detail: "Notifications are blocked in System Settings", remedy: { url: SETTINGS_URL, caption: "Turn on Allow notifications for pacer" } };
  expect(notificationCaption(check)).toBe("Blocked in System Settings");
});

test("Desktop banners caption names quiet delivery when banners are off", () => {
  const check: CaptionCheck = { level: "warn", detail: "Notifications arrive quietly, without banners", remedy: { url: SETTINGS_URL, caption: "Choose Banners for pacer" } };
  expect(notificationCaption(check)).toBe("Notifications arrive quietly, without banners");
});

test("Desktop banners caption names an unconfirmed test", () => {
  const check: CaptionCheck = { level: "warn", detail: "The desktop didn't confirm the test notification", remedy: { op: "notifications.test" } };
  expect(notificationCaption(check)).toBe("The desktop didn't confirm the test notification");
});

test("Desktop banners caption keeps a rejected banner detail as-is", () => {
  const check: CaptionCheck = { level: "warn", detail: "The banner was rejected: denied", remedy: { op: "notifications.test" } };
  expect(notificationCaption(check)).toBe("The banner was rejected: denied");
});

test("Desktop banners caption keeps an unhandled warn detail as-is", () => {
  expect(notificationCaption({ level: "warn", detail: "Some custom problem" })).toBe("Some custom problem");
});

test("Desktop banners caption reports an untested but allowed permission", () => {
  expect(notificationCaption({ level: "ok", detail: "Banners allowed · not tested yet" })).toBe("Allowed · not tested yet");
});

test("Desktop banners caption reports a delivered test relatively", () => {
  const tested_at = Date.now() / 1000 - 2 * 60;
  const caption = notificationCaption({ level: "ok", detail: "Banners allowed · test delivered", tested_at });
  expect(caption).toMatch(/^Allowed · test delivered \d+m ago$/);
});

test("Desktop banners caption passes informational states through", () => {
  expect(notificationCaption({ level: "info", detail: "The pacer app isn't open; banners come from the system fallback" }))
    .toBe("The pacer app isn't open; banners come from the system fallback");
  expect(notificationCaption({ level: "info", detail: "This development build can't post banners" })).toBe("This development build can't post banners");
  expect(notificationCaption({ level: "info", detail: "Notifications are off" })).toBe("Notifications are off");
});

test("Desktop banners caption shows a checking placeholder before the doctor answers", () => {
  expect(notificationCaption(undefined)).toBe("Checking…");
});