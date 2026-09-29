// @cnote/notifications — observer-pattern notification service (in-app now; email via @cnote/email;
// WhatsApp/SMS adapters stubbed). Domain events → kinds → per-person Notification rows → channels
// through the JobQueue, honouring preferences and consent. Framework-free.
// PUBLIC CONTRACT. Extend, don't break.
export type {
  NotificationApp, NotificationCategory, NotificationChannel, ExtraChannel, NotificationKind, NotificationView, PreferenceMatrix, Recipient,
} from "./types";
export { NOTIFICATION_APPS, CATEGORIES, CHANNELS } from "./types";
export { KINDS, getKind, kindsFor, observedEvents, templateDefinitions, registerNotificationTemplates } from "./kinds";
export { listNotifications, unreadCount, markRead, type ListOptions } from "./read";
export { getPreferences, setPreference, channelLock, effectiveChannels, defaultPreference, CATEGORY_META, CHANNEL_LABEL } from "./preferences";
export { notifyForEvent, notifyRecipient, deliverJob, absoluteUrl, type NotificationDeliverJob } from "./pipeline";
export { setChannelAdapter, type ChannelAdapter, type ChannelMessage } from "./channels";
export type { Directory } from "./recipients";
export { listQueueTopics, registerQueueTopic, listDeadLetters, replayDeadLetter, listEmailLog, EMAIL_STATUSES, type QueueTopicInfo, type EmailLogEntry } from "./ops";
export { worker, pruneReadNotifications } from "./worker";
