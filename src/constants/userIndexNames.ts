export const USER_INDEX_NAMES = {
    TYPE_INDEX: "TypeIndex",
    // NOTIFY_UTC_INDEX: "NotifyUtcIndex",
    ALL_EVENTS_INDEX: "AllEventsIndex",
  } as const;

  export const USER_INDEX_NAME_VALUES = [
    USER_INDEX_NAMES.TYPE_INDEX,
    // USER_INDEX_NAMES.NOTIFY_UTC_INDEX,
    USER_INDEX_NAMES.ALL_EVENTS_INDEX,
  ] as const;

  export type UserIndexName = typeof USER_INDEX_NAME_VALUES[number];