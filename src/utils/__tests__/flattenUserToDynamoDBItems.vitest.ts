import { describe, it, expect } from 'vitest';
import { flattenUserToDynamoDBItems } from '../flattenUserToDynamoDBItems';
import type { User, UserEvent } from '../../types';
import { USER_EVENT_NAMES } from '../../constants/userEventNames';

describe('flattenUserToDynamoDBItems', () => {
  describe('Basic functionality', () => {
    it('should create metadata item and event items for user with one event', () => {
      const user: User & { events: UserEvent[] } = {
        id: 'user-123',
        firstName: 'John',
        lastName: 'Doe',
        timezone: 'America/New_York',
        events: [
          {
            type: USER_EVENT_NAMES.BIRTHDAY,
            date: '1990-06-15',
            notifyLocalTime: '09:00',
            notifyUtc: '2026-06-15T13:00:00.000Z',
            lastSentYear: 2025,
          },
        ],
      };

      const result = flattenUserToDynamoDBItems(user);

      expect(result).toHaveLength(2); // 1 metadata + 1 event

      // Check metadata item
      const metadataItem = result.find(item => item.SK === 'METADATA');
      expect(metadataItem).toBeDefined();
      expect(metadataItem).toEqual({
        PK: 'USER#user-123',
        SK: 'METADATA',
        data: {
          id: 'user-123',
          firstName: 'John',
          lastName: 'Doe',
          timezone: 'America/New_York',
        },
      });

      // Check event item
      const eventItem = result.find(item => item.SK === 'EVENT#birthday');
      expect(eventItem).toBeDefined();
      expect(eventItem).toEqual({
        PK: 'USER#user-123',
        SK: 'EVENT#birthday',
        GSI1PK: 'EVENT',
        type: 'birthday',
        date: '1990-06-15',
        notifyLocalTime: '09:00',
        notifyUtc: '2026-06-15T13:00:00.000Z',
        lastSentYear: 2025,
        sendingStatus: 'pending',
      });
    });

    it('should create items for user with multiple events', () => {
      const user: User & { events: UserEvent[] } = {
        id: 'user-456',
        firstName: 'Jane',
        lastName: 'Smith',
        timezone: 'Europe/London',
        events: [
          {
            type: USER_EVENT_NAMES.BIRTHDAY,
            date: '1985-03-20',
            notifyLocalTime: '09:00',
            notifyUtc: '2026-03-20T09:00:00.000Z',
            lastSentYear: 2025,
          },
          {
            type: USER_EVENT_NAMES.ANNIVERSARY,
            date: '2020-06-10',
            notifyLocalTime: '10:00',
            notifyUtc: '2026-06-10T09:00:00.000Z',
            lastSentYear: 2025,
            label: 'Wedding Anniversary',
          },
        ],
      };

      const result = flattenUserToDynamoDBItems(user);

      expect(result).toHaveLength(3); // 1 metadata + 2 events

      // Check metadata
      const metadataItem = result.find(item => item.SK === 'METADATA');
      expect(metadataItem?.PK).toBe('USER#user-456');
      expect(metadataItem?.SK).toBe('METADATA');

      // Check both events exist
      const birthdayItem = result.find(item => item.SK === 'EVENT#birthday');
      const anniversaryItem = result.find(item => item.SK === 'EVENT#anniversary');

      expect(birthdayItem).toBeDefined();
      expect(anniversaryItem).toBeDefined();
      expect((anniversaryItem as any)?.label).toBe('Wedding Anniversary');
    });
  });

  describe('Event with optional label', () => {
    it('should include label when provided', () => {
      const user: User & { events: UserEvent[] } = {
        id: 'user-789',
        firstName: 'Bob',
        lastName: 'Johnson',
        timezone: 'Asia/Tokyo',
        events: [
          {
            type: USER_EVENT_NAMES.ANNIVERSARY,
            date: '2015-01-01',
            notifyLocalTime: '12:00',
            notifyUtc: '2026-01-01T03:00:00.000Z',
            lastSentYear: 2025,
            label: 'Work Anniversary',
          },
        ],
      };

      const result = flattenUserToDynamoDBItems(user);
      const eventItem = result.find(item => item.SK === 'EVENT#anniversary') as any;

      expect(eventItem).toBeDefined();
      expect(eventItem.label).toBe('Work Anniversary');
    });

    it('should not include label when not provided', () => {
      const user: User & { events: UserEvent[] } = {
        id: 'user-999',
        firstName: 'Alice',
        lastName: 'Williams',
        timezone: 'UTC',
        events: [
          {
            type: USER_EVENT_NAMES.BIRTHDAY,
            date: '1992-12-25',
            notifyLocalTime: '09:00',
            notifyUtc: '2026-12-25T09:00:00.000Z',
            lastSentYear: 2025,
            // No label
          },
        ],
      };

      const result = flattenUserToDynamoDBItems(user);
      const eventItem = result.find(item => item.SK === 'EVENT#birthday') as any;

      expect(eventItem).toBeDefined();
      expect(eventItem.label).toBeUndefined();
    });
  });

  describe('PK and SK structure', () => {
    it('should create correct PK format for user', () => {
      const user: User & { events: UserEvent[] } = {
        id: 'test-user-id',
        firstName: 'Test',
        lastName: 'User',
        timezone: 'UTC',
        events: [
          {
            type: USER_EVENT_NAMES.BIRTHDAY,
            date: '2000-01-01',
            notifyLocalTime: '09:00',
            notifyUtc: '2026-01-01T09:00:00.000Z',
            lastSentYear: 0,
          },
        ],
      };

      const result = flattenUserToDynamoDBItems(user);

      // All items should have same PK
      result.forEach(item => {
        expect(item.PK).toBe('USER#test-user-id');
        expect(item.PK).toMatch(/^USER#/);
      });
    });

    it('should create correct SK format for events', () => {
      const user: User & { events: UserEvent[] } = {
        id: 'user-123',
        firstName: 'Test',
        lastName: 'User',
        timezone: 'UTC',
        events: [
          {
            type: USER_EVENT_NAMES.BIRTHDAY,
            date: '2000-01-01',
            notifyLocalTime: '09:00',
            notifyUtc: '2026-01-01T09:00:00.000Z',
            lastSentYear: 0,
          },
          {
            type: USER_EVENT_NAMES.ANNIVERSARY,
            date: '2020-01-01',
            notifyLocalTime: '09:00',
            notifyUtc: '2026-01-01T09:00:00.000Z',
            lastSentYear: 0,
          },
        ],
      };

      const result = flattenUserToDynamoDBItems(user);

      const birthdayItem = result.find(item => item.SK === 'EVENT#birthday');
      const anniversaryItem = result.find(item => item.SK === 'EVENT#anniversary');

      expect(birthdayItem?.SK).toBe('EVENT#birthday');
      expect(anniversaryItem?.SK).toBe('EVENT#anniversary');
      expect(birthdayItem?.SK).toMatch(/^EVENT#/);
    });
  });

  describe('GSI1PK for events', () => {
    it('should set GSI1PK to "EVENT" for all event items', () => {
      const user: User & { events: UserEvent[] } = {
        id: 'user-123',
        firstName: 'Test',
        lastName: 'User',
        timezone: 'UTC',
        events: [
          {
            type: USER_EVENT_NAMES.BIRTHDAY,
            date: '2000-01-01',
            notifyLocalTime: '09:00',
            notifyUtc: '2026-01-01T09:00:00.000Z',
            lastSentYear: 0,
          },
          {
            type: USER_EVENT_NAMES.ANNIVERSARY,
            date: '2020-01-01',
            notifyLocalTime: '09:00',
            notifyUtc: '2026-01-01T09:00:00.000Z',
            lastSentYear: 0,
          },
        ],
      };

      const result = flattenUserToDynamoDBItems(user);

      const eventItems = result.filter(item => item.SK !== 'METADATA');
      eventItems.forEach(item => {
        expect((item as any).GSI1PK).toBe('EVENT');
      });

      // Metadata item should not have GSI1PK
      const metadataItem = result.find(item => item.SK === 'METADATA');
      expect((metadataItem as any).GSI1PK).toBeUndefined();
    });
  });

  describe('Metadata item structure', () => {
    it('should include all user fields in metadata data object', () => {
      const user: User & { events: UserEvent[] } = {
        id: 'user-123',
        firstName: 'John',
        lastName: 'Doe',
        timezone: 'America/New_York',
        events: [
          {
            type: USER_EVENT_NAMES.BIRTHDAY,
            date: '1990-01-01',
            notifyLocalTime: '09:00',
            notifyUtc: '2026-01-01T14:00:00.000Z',
            lastSentYear: 0,
          },
        ],
      };

      const result = flattenUserToDynamoDBItems(user);
      const metadataItem = result.find(item => item.SK === 'METADATA') as any;

      expect(metadataItem.data).toEqual({
        id: 'user-123',
        firstName: 'John',
        lastName: 'Doe',
        timezone: 'America/New_York',
      });
    });

    it('should not include events in metadata data', () => {
      const user: User & { events: UserEvent[] } = {
        id: 'user-123',
        firstName: 'John',
        lastName: 'Doe',
        timezone: 'UTC',
        events: [
          {
            type: USER_EVENT_NAMES.BIRTHDAY,
            date: '1990-01-01',
            notifyLocalTime: '09:00',
            notifyUtc: '2026-01-01T09:00:00.000Z',
            lastSentYear: 0,
          },
        ],
      };

      const result = flattenUserToDynamoDBItems(user);
      const metadataItem = result.find(item => item.SK === 'METADATA') as any;

      expect(metadataItem.data.events).toBeUndefined();
      expect(metadataItem.data).not.toHaveProperty('events');
    });
  });

  describe('Event item structure', () => {
    it('should include all required event fields', () => {
      const user: User & { events: UserEvent[] } = {
        id: 'user-123',
        firstName: 'Test',
        lastName: 'User',
        timezone: 'UTC',
        events: [
          {
            type: USER_EVENT_NAMES.BIRTHDAY,
            date: '1990-06-15',
            notifyLocalTime: '09:00',
            notifyUtc: '2026-06-15T09:00:00.000Z',
            lastSentYear: 2025,
          },
        ],
      };

      const result = flattenUserToDynamoDBItems(user);
      const eventItem = result.find(item => item.SK === 'EVENT#birthday') as any;

      expect(eventItem).toHaveProperty('type', 'birthday');
      expect(eventItem).toHaveProperty('date', '1990-06-15');
      expect(eventItem).toHaveProperty('notifyLocalTime', '09:00');
      expect(eventItem).toHaveProperty('notifyUtc', '2026-06-15T09:00:00.000Z');
      expect(eventItem).toHaveProperty('lastSentYear', 2025);
      expect(eventItem).toHaveProperty('GSI1PK', 'EVENT');
    });

    it('should preserve all event field values correctly', () => {
      const user: User & { events: UserEvent[] } = {
        id: 'user-123',
        firstName: 'Test',
        lastName: 'User',
        timezone: 'America/Los_Angeles',
        events: [
          {
            type: USER_EVENT_NAMES.ANNIVERSARY,
            date: '2010-12-31',
            notifyLocalTime: '18:30',
            notifyUtc: '2026-01-01T02:30:00.000Z',
            lastSentYear: 2024,
            label: 'Custom Label',
          },
        ],
      };

      const result = flattenUserToDynamoDBItems(user);
      const eventItem = result.find(item => item.SK === 'EVENT#anniversary') as any;

      expect(eventItem.type).toBe('anniversary');
      expect(eventItem.date).toBe('2010-12-31');
      expect(eventItem.notifyLocalTime).toBe('18:30');
      expect(eventItem.notifyUtc).toBe('2026-01-01T02:30:00.000Z');
      expect(eventItem.lastSentYear).toBe(2024);
      expect(eventItem.label).toBe('Custom Label');
    });
  });

  describe('Edge cases', () => {
    it('should handle user with no events', () => {
      const user: User & { events: UserEvent[] } = {
        id: 'user-empty',
        firstName: 'Empty',
        lastName: 'User',
        timezone: 'UTC',
        events: [],
      };

      const result = flattenUserToDynamoDBItems(user);

      expect(result).toHaveLength(1); // Only metadata item
      expect(result[0]!.SK).toBe('METADATA');
    });

    it('should handle user with many events', () => {
      const events: UserEvent[] = Array.from({ length: 10 }, (_, i) => ({
        type: i % 2 === 0 ? USER_EVENT_NAMES.BIRTHDAY : USER_EVENT_NAMES.ANNIVERSARY,
        date: `1990-0${i + 1}-01`,
        notifyLocalTime: '09:00',
        notifyUtc: `2026-0${i + 1}-01T09:00:00.000Z`,
        lastSentYear: 0,
      }));

      const user: User & { events: UserEvent[] } = {
        id: 'user-many',
        firstName: 'Many',
        lastName: 'Events',
        timezone: 'UTC',
        events,
      };

      const result = flattenUserToDynamoDBItems(user);

      expect(result).toHaveLength(11); // 1 metadata + 10 events
      expect(result.filter(item => item.SK === 'METADATA')).toHaveLength(1);
      expect(result.filter(item => item.SK.startsWith('EVENT#'))).toHaveLength(10);
    });

    it('should handle special characters in user ID', () => {
      const user: User & { events: UserEvent[] } = {
        id: 'user-with-special-chars-123!@#',
        firstName: 'Special',
        lastName: 'User',
        timezone: 'UTC',
        events: [
          {
            type: USER_EVENT_NAMES.BIRTHDAY,
            date: '1990-01-01',
            notifyLocalTime: '09:00',
            notifyUtc: '2026-01-01T09:00:00.000Z',
            lastSentYear: 0,
          },
        ],
      };

      const result = flattenUserToDynamoDBItems(user);

      expect(result).toHaveLength(2);
      expect(result[0]!.PK).toBe('USER#user-with-special-chars-123!@#');
      expect(result[1]!.PK).toBe('USER#user-with-special-chars-123!@#');
    });
  });

  describe('Return value structure', () => {
    it('should return array with metadata first, then events', () => {
      const user: User & { events: UserEvent[] } = {
        id: 'user-123',
        firstName: 'Test',
        lastName: 'User',
        timezone: 'UTC',
        events: [
          {
            type: USER_EVENT_NAMES.BIRTHDAY,
            date: '1990-01-01',
            notifyLocalTime: '09:00',
            notifyUtc: '2026-01-01T09:00:00.000Z',
            lastSentYear: 0,
          },
          {
            type: USER_EVENT_NAMES.ANNIVERSARY,
            date: '2020-01-01',
            notifyLocalTime: '09:00',
            notifyUtc: '2026-01-01T09:00:00.000Z',
            lastSentYear: 0,
          },
        ],
      };

      const result = flattenUserToDynamoDBItems(user);

      expect(result).toHaveLength(3);
      expect(result[0]!.SK).toBe('METADATA');
      expect(result[1]!.SK).toBe('EVENT#birthday');
      expect(result[2]!.SK).toBe('EVENT#anniversary');
    });

    it('should return items that match DynamoDBUserItem type', () => {
      const user: User & { events: UserEvent[] } = {
        id: 'user-123',
        firstName: 'Test',
        lastName: 'User',
        timezone: 'UTC',
        events: [
          {
            type: USER_EVENT_NAMES.BIRTHDAY,
            date: '1990-01-01',
            notifyLocalTime: '09:00',
            notifyUtc: '2026-01-01T09:00:00.000Z',
            lastSentYear: 0,
          },
        ],
      };

      const result = flattenUserToDynamoDBItems(user);

      // Metadata item should have correct structure
      const metadataItem = result[0];
      expect(metadataItem).toHaveProperty('PK');
      expect(metadataItem).toHaveProperty('SK', 'METADATA');
      expect(metadataItem).toHaveProperty('data');
      expect((metadataItem as any).data).toHaveProperty('id');
      expect((metadataItem as any).data).toHaveProperty('firstName');
      expect((metadataItem as any).data).toHaveProperty('lastName');
      expect((metadataItem as any).data).toHaveProperty('timezone');

      // Event item should have correct structure
      const eventItem = result[1] as any;
      expect(eventItem).toHaveProperty('PK');
      expect(eventItem).toHaveProperty('SK');
      expect(eventItem).toHaveProperty('GSI1PK', 'EVENT');
      expect(eventItem).toHaveProperty('type');
      expect(eventItem).toHaveProperty('date');
      expect(eventItem).toHaveProperty('notifyLocalTime');
      expect(eventItem).toHaveProperty('notifyUtc');
      expect(eventItem).toHaveProperty('lastSentYear');
    });
  });
});
