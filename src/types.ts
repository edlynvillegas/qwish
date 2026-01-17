import type { UserEventName } from "./constants/userEventNames";

/**
 * Message sending status for tracking lifecycle
 */
export type MessageSendingStatus = 'pending' | 'sending' | 'completed' | 'failed';

/**
 * Represents a date-based event that can be celebrated (birthday, anniversary, etc.)
 */
export interface UserEvent {
    /** Type of event (birthday, anniversary, etc.) */
    type: UserEventName;
    /** Date of the event in YYYY-MM-DD format */
    date: string;
    /** Local time to send notification in HH:mm format (e.g., '09:00') */
    notifyLocalTime: string;
    /** UTC timestamp for next notification */
    notifyUtc: string;
    /** Timestamp when event was created (ISO 8601) */
    createdAt: string;
    /** Timestamp when event was last updated (ISO 8601) */
    updatedAt: string;
    /** Last year this event was sent (prevents duplicates) */
    lastSentYear: number;
    /** Optional label/name for the event (e.g., "Wedding Anniversary", "Work Anniversary") */
    label?: string;
    /** Current sending status for this year's message (optional for backward compatibility) */
    sendingStatus?: MessageSendingStatus;
    /** Timestamp when sending was last attempted (ISO 8601) */
    sendingAttemptedAt?: string;
    /** Timestamp when sending was completed successfully (ISO 8601) */
    sendingCompletedAt?: string;
    /** Timestamp when message was marked as failed (ISO 8601) */
    markedFailedAt?: string;
    /** Reason for failure */
    failureReason?: string;
    /** HTTP response code from webhook call */
    webhookResponseCode?: number;
    /** Timestamp when webhook was delivered successfully (ISO 8601) */
    webhookDeliveredAt?: string;
}

export interface User {
    id: string;
    firstName: string;
    lastName: string;
    timezone: string;
    createdAt: string;
    updatedAt: string;
}

export type DynamoDBUserItem =
  // User metadata item
  | {
      PK: `USER#${string}`;
      SK: "METADATA";
      data: User;
    }
  // Flattened user event item
  | {
      PK: `USER#${string}`;
      SK: `EVENT#${string}`; // you can also use a unique event ID
      type: UserEventName;
      date: string;
      notifyLocalTime: string;
      notifyUtc: string;
      lastSentYear: number;
      GSI1PK: "EVENT";
      label?: string;
      sendingStatus?: MessageSendingStatus;
      sendingAttemptedAt?: string;
      sendingCompletedAt?: string;
      markedFailedAt?: string;
      failureReason?: string;
      webhookResponseCode?: number;
      webhookDeliveredAt?: string;
      createdAt: string;
      updatedAt: string;
    };