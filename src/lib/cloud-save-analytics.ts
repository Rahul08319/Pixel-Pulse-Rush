/**
 * Cloud Save Reliability & Retry Analytics Instrumentation
 * 
 * Tracks retry attempts, backoff timings, payload sizes, and failure reasons
 * across sessions using persistent localStorage event streaming.
 */

export interface CloudSaveAnalyticsEvent {
  id: string;
  timestamp: number;
  type:
    | "save_queued"
    | "save_attempt"
    | "save_success"
    | "save_retry_scheduled"
    | "save_abandoned";
  attempt: number;
  maxAttempts: number;
  backoffDelayMs?: number;
  errorReason?: string;
  inPlayables: boolean;
  payloadSize: number;
  note?: string;
}

export interface CloudSaveAnalyticsSummary {
  totalAttempts: number;
  successfulSaves: number;
  retriesScheduled: number;
  abandonedCount: number;
  lastBackoffDelayMs: number | null;
  lastFailureReason: string | null;
  lastEventAt: number | null;
  recentEvents: CloudSaveAnalyticsEvent[];
}

const ANALYTICS_STORAGE_KEY = "ppr:analytics:cloud_save:v1";
const MAX_STORED_EVENTS = 60;

function safeReadEvents(): CloudSaveAnalyticsEvent[] {
  if (typeof window === "undefined" || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(ANALYTICS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeWriteEvents(events: CloudSaveAnalyticsEvent[]): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const trimmed = events.slice(-MAX_STORED_EVENTS);
    window.localStorage.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* ignore storage quota errors */
  }
}

function generateEventId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Appends a cloud save analytics event to persistent storage and dispatches
 * a CustomEvent for runtime listeners / telemetry collectors.
 */
export function trackCloudSaveEvent(
  eventData: Omit<CloudSaveAnalyticsEvent, "id" | "timestamp">,
): CloudSaveAnalyticsEvent {
  const event: CloudSaveAnalyticsEvent = {
    ...eventData,
    id: generateEventId(),
    timestamp: Date.now(),
  };

  const current = safeReadEvents();
  current.push(event);
  safeWriteEvents(current);

  // Dispatch custom browser event for observability
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(
        new CustomEvent("ppr:cloud_save_analytics", { detail: event }),
      );
    } catch {
      /* ignore */
    }
  }

  return event;
}

/**
 * Returns summary metrics of cloud save reliability across sessions.
 */
export function getCloudSaveAnalyticsSummary(): CloudSaveAnalyticsSummary {
  const events = safeReadEvents();
  let totalAttempts = 0;
  let successfulSaves = 0;
  let retriesScheduled = 0;
  let abandonedCount = 0;
  let lastBackoffDelayMs: number | null = null;
  let lastFailureReason: string | null = null;
  let lastEventAt: number | null = null;

  for (const e of events) {
    if (e.type === "save_attempt") totalAttempts++;
    if (e.type === "save_success") successfulSaves++;
    if (e.type === "save_retry_scheduled") {
      retriesScheduled++;
      if (e.backoffDelayMs) lastBackoffDelayMs = e.backoffDelayMs;
      if (e.errorReason) lastFailureReason = e.errorReason;
    }
    if (e.type === "save_abandoned") {
      abandonedCount++;
      if (e.errorReason) lastFailureReason = e.errorReason;
    }
    lastEventAt = e.timestamp;
  }

  return {
    totalAttempts,
    successfulSaves,
    retriesScheduled,
    abandonedCount,
    lastBackoffDelayMs,
    lastFailureReason,
    lastEventAt,
    recentEvents: events.slice(-15),
  };
}

export function getAllCloudSaveAnalyticsEvents(): CloudSaveAnalyticsEvent[] {
  return safeReadEvents();
}

export function clearCloudSaveAnalytics(): void {
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.removeItem(ANALYTICS_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}
