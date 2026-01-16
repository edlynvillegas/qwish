/**
 * Event type for different date-based celebrations
 */
export const USER_EVENT_NAMES = {
    BIRTHDAY: "birthday",
    ANNIVERSARY: "anniversary",
    // Add more event types as needed in the future
  } as const;
  
  /**
   * Extract the string literal values as a tuple
   */
  export const USER_EVENT_NAME_VALUES = [
    USER_EVENT_NAMES.BIRTHDAY,
    USER_EVENT_NAMES.ANNIVERSARY,
  ] as const;
  
  /**
   * Type for a user event name
   */
  export type UserEventName = typeof USER_EVENT_NAME_VALUES[number];
  