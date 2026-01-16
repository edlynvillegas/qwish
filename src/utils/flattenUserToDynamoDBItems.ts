import type { DynamoDBUserItem, User, UserEvent } from "../types";

export function flattenUserToDynamoDBItems(user: User & { events: UserEvent[] }): DynamoDBUserItem[] {
    const userPK: `USER#${string}` = `USER#${user.id}`;
  
    // User metadata item
    const metadataItem: DynamoDBUserItem = {
      PK: userPK,
      SK: "METADATA",
      data: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        timezone: user.timezone,
      },
    };
  
    // Flatten events
    const eventItems: DynamoDBUserItem[] = user.events.map((event) => {
        const eventSK: `EVENT#${string}` = `EVENT#${event.type}`;
        const eventItem: DynamoDBUserItem = {
            PK: userPK,
            SK: eventSK,
            GSI1PK: "EVENT",
            type: event.type,
            date: event.date,
            notifyLocalTime: event.notifyLocalTime,
            notifyUtc: event.notifyUtc,
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
  