import type { DynamoDBUserItem, User, UserEvent } from "../types";

export function flattenUserToDynamoDBItems(user: User & { events: UserEvent[] }): DynamoDBUserItem[] {
    const userPK: `USER#${string}` = `USER#${user.id}`;
    const userCreatedAt = user.createdAt ?? new Date().toISOString();
    const userUpdatedAt = user.updatedAt ?? userCreatedAt;
  
    // User metadata item
    const metadataItem: DynamoDBUserItem = {
      PK: userPK,
      SK: "METADATA",
      data: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        timezone: user.timezone,
        createdAt: userCreatedAt,
        updatedAt: userUpdatedAt,
      },
    };
  
    // Flatten events
    const eventItems: DynamoDBUserItem[] = user.events.map((event) => {
        const eventSK: `EVENT#${string}` = `EVENT#${event.type}`;
        const eventCreatedAt = event.createdAt ?? userCreatedAt;
        const eventUpdatedAt = event.updatedAt ?? userUpdatedAt;
        const eventItem: DynamoDBUserItem = {
            PK: userPK,
            SK: eventSK,
            GSI1PK: "EVENT",
            type: event.type,
            date: event.date,
            notifyLocalTime: event.notifyLocalTime,
            notifyUtc: event.notifyUtc,
            createdAt: eventCreatedAt,
            updatedAt: eventUpdatedAt,
            lastSentYear: event.lastSentYear,
            sendingStatus: 'pending' // Initialize new events as pending
        }
        if (event.label) {
            eventItem.label = event.label;
        }
        return eventItem;
    });
  
    return [metadataItem, ...eventItems];
  }
  