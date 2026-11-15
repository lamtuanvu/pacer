import * as clients from "../clients/registry";
import * as notificationHealth from "../core/notification-health";
import { getLevel as getNotificationLevel } from "../core/notify";
import { remedies } from "./doctor-remedy";
import type { Ctx } from "../types";
import type { Check } from "./doctor";

export function notificationsCheck(ctx: Ctx): Check {
  const notificationLevel = getNotificationLevel(ctx).level;
  const liveClients = clients.list(ctx);
  const presenters = clients.deliveryPresenters(ctx);
  const osPresenter = presenters.find(p => p.medium === "os");
  let desktop = osPresenter ? liveClients.find(c => c.client_id === osPresenter.client_id) : undefined;
  if (!desktop) desktop = liveClients.slice().reverse().find(c => c.kind === "desktop");
  const health = notificationHealth.readHealth(ctx);

  if (notificationLevel === "off") {
    return { name: "Notifications", level: "info", detail: "Notifications are off" };
  }
  if (!desktop) {
    return { name: "Notifications", level: "info", detail: "The pacer app isn't open; banners come from the system fallback", evidence: "unverified" };
  }
  if (desktop.notification_permission === "unsupported") {
    return { name: "Notifications", level: "info", detail: "This development build can't post banners" };
  }
  // An older desktop that has not reported a permission at all is a version gap, not ok.
  if (desktop.notification_permission === undefined) {
    return { name: "Notifications", level: "info", detail: "Update the pacer app to check notifications" };
  }
  if (desktop.notification_permission === "not_determined") {
    return { name: "Notifications", level: "warn", detail: "Notification permission not asked yet", remedy: remedies.allowNotifications() };
  }
  if (desktop.notification_permission === "denied") {
    return { name: "Notifications", level: "warn", detail: "Notifications are blocked in System Settings", remedy: remedies.notificationSettings("Turn on Allow notifications for pacer") };
  }
  if (desktop.notification_permission === "provisional" || desktop.notification_alerts === "none") {
    return { name: "Notifications", level: "warn", detail: "Notifications arrive quietly, without banners", remedy: remedies.notificationSettings("Choose Banners for pacer") };
  }
  const lastErrorNewer = !!health?.last_error && (!health.last_ok_at || health.last_error.at > (health.last_ok_at ?? 0));
  const unacked = !!health?.key && !!health.sent_at && (!health.acked_at || (health.acked_at < health.sent_at)) && ctx.now - health.sent_at > 15;
  if (lastErrorNewer || unacked) {
    const detail = lastErrorNewer
      ? `The banner was rejected: ${health!.last_error!.message}`
      : "The desktop didn't confirm the test notification";
    return { name: "Notifications", level: "warn", detail, remedy: remedies.testNotification() };
  }
  // A delivered test counts only if it was acked after the last permission change.
  const tested =
    desktop.notification_permission === "authorized" && health?.delivered === true &&
    !!health.acked_at && !!health.sent_at && health.acked_at >= health.sent_at &&
    (!desktop.permission_changed_at || health.acked_at >= desktop.permission_changed_at);
  if (tested) {
    return { name: "Notifications", level: "ok", detail: "Banners allowed · test delivered", evidence: "tested", tested_at: health!.acked_at };
  }
  return { name: "Notifications", level: "ok", detail: "Banners allowed · not tested yet", evidence: "configured" };
}