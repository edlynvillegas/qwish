import { describe, it, expect, beforeEach, vi } from 'vitest';
import { healthCheck } from '../healthCheck';
import { dynamoClient } from '../../lib/dynamodb';
import dayjs from '../../lib/dayjs';

vi.mock('../../lib/dynamodb', () => ({
  dynamoClient: {
    send: vi.fn(),
  },
  USERS_TABLE: 'Users',
}));

describe('healthCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return healthy status when no missed events', async () => {
    const mockSend = vi.mocked(dynamoClient.send);
    // First call for missed events, second call for stuck events
    mockSend.mockResolvedValueOnce({
      Items: [],
      $metadata: {}
    }).mockResolvedValueOnce({
      Items: [],
      $metadata: {}
    });

    const result = await healthCheck();

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.status).toBe('healthy');
    expect(body.missedEventsCount).toBe(0);
    expect(body.stuckEventsCount).toBe(0);
    expect(body.missedEvents).toEqual([]);
    expect(body.stuckEvents).toEqual([]);
  });

  it('should return warning status when 1-4 missed events', async () => {
    const now = dayjs.utc();
    const twoHoursAgo = now.subtract(2, 'hours').toISOString();
    
    const mockSend = vi.mocked(dynamoClient.send);
    // First call for missed events
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          PK: 'USER#123',
          SK: 'EVENT#birthday',
          type: 'birthday',
          date: '1990-01-15',
          notifyUtc: twoHoursAgo,
          lastSentYear: 2025,
          sendingStatus: 'pending'
        },
        {
          PK: 'USER#456',
          SK: 'EVENT#anniversary',
          type: 'anniversary',
          date: '2010-03-20',
          notifyUtc: twoHoursAgo,
          lastSentYear: 0
        }
      ],
      $metadata: {}
    }).mockResolvedValueOnce({
      // Second call for stuck events - none
      Items: [],
      $metadata: {}
    });

    const result = await healthCheck();

    expect(result.statusCode).toBe(207); // Multi-status for warning
    const body = JSON.parse(result.body);
    expect(body.status).toBe('warning');
    expect(body.missedEventsCount).toBe(2);
    expect(body.stuckEventsCount).toBe(0);
    expect(body.missedEvents).toHaveLength(2);
    expect(body.missedEvents[0].userId).toBe('USER#123');
    expect(body.missedEvents[0].eventType).toBe('birthday');
    expect(body.missedEvents[0].hoursOverdue).toBeGreaterThan(1.9);
    expect(body.missedEvents[0].hoursOverdue).toBeLessThan(2.1);
  });

  it('should return critical status when 5+ missed events', async () => {
    const now = dayjs.utc();
    const fiveHoursAgo = now.subtract(5, 'hours').toISOString();
    
    const missedEvents = Array.from({ length: 6 }, (_, i) => ({
      PK: `USER#${i}`,
      SK: `EVENT#event${i}`,
      type: 'birthday',
      date: '1990-01-15',
      notifyUtc: fiveHoursAgo,
      lastSentYear: 2025
    }));

    const mockSend = vi.mocked(dynamoClient.send);
    // First call for missed events
    mockSend.mockResolvedValueOnce({
      Items: missedEvents,
      $metadata: {}
    }).mockResolvedValueOnce({
      // Second call for stuck events - none
      Items: [],
      $metadata: {}
    });

    const result = await healthCheck();

    expect(result.statusCode).toBe(500); // Error status for critical
    const body = JSON.parse(result.body);
    expect(body.status).toBe('critical');
    expect(body.missedEventsCount).toBe(6);
    expect(body.stuckEventsCount).toBe(0);
    expect(body.missedEvents).toHaveLength(6);
  });

  it('should handle events with missing lastSentYear attribute', async () => {
    const now = dayjs.utc();
    const oneHourAgo = now.subtract(1, 'hours').toISOString();
    
    const mockSend = vi.mocked(dynamoClient.send);
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          PK: 'USER#789',
          SK: 'EVENT#birthday',
          type: 'birthday',
          date: '1995-06-10',
          notifyUtc: oneHourAgo,
          // lastSentYear is missing (undefined)
        }
      ],
      $metadata: {}
    }).mockResolvedValueOnce({
      Items: [],
      $metadata: {}
    });

    const result = await healthCheck();

    expect(result.statusCode).toBe(207);
    const body = JSON.parse(result.body);
    expect(body.status).toBe('warning');
    expect(body.missedEventsCount).toBe(1);
    expect(body.missedEvents[0].lastSentYear).toBe(0); // Should default to 0
  });

  it('should return error status when query fails', async () => {
    const mockSend = vi.mocked(dynamoClient.send);
    mockSend.mockRejectedValue(new Error('DynamoDB connection failed'));

    const result = await healthCheck();

    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body);
    expect(body.status).toBe('error');
    expect(body.message).toBe('Health check execution failed');
    expect(body.error).toBe('DynamoDB connection failed');
  });

  it('should query events from last 24 hours only', async () => {
    const mockSend = vi.mocked(dynamoClient.send);
    mockSend.mockResolvedValueOnce({
      Items: [],
      $metadata: {}
    }).mockResolvedValueOnce({
      Items: [],
      $metadata: {}
    });

    await healthCheck();

    expect(mockSend).toHaveBeenCalledTimes(2); // Two queries: missed + stuck
    const queryCommand = mockSend.mock.calls[0][0];
    const input = (queryCommand as any).input;

    expect(input.IndexName).toBe('AllEventsIndex');
    expect(input.KeyConditionExpression).toContain('BETWEEN');
    expect(input.FilterExpression).toContain('lastSentYear');
    
    // Verify the time window is approximately 24 hours
    const oneDayAgo = input.ExpressionAttributeValues[':oneDayAgo'];
    const now = input.ExpressionAttributeValues[':now'];
    const currentYear = input.ExpressionAttributeValues[':year'];
    
    expect(currentYear).toBe(new Date().getFullYear());
    
    const diffHours = dayjs(now).diff(dayjs(oneDayAgo), 'hours');
    expect(diffHours).toBe(24);
  });

  it('should calculate hours overdue correctly', async () => {
    const now = dayjs.utc();
    const threeAndHalfHoursAgo = now.subtract(3.5, 'hours').toISOString();
    
    const mockSend = vi.mocked(dynamoClient.send);
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          PK: 'USER#123',
          SK: 'EVENT#birthday',
          type: 'birthday',
          date: '1990-01-15',
          notifyUtc: threeAndHalfHoursAgo,
          lastSentYear: 2025
        }
      ],
      $metadata: {}
    }).mockResolvedValueOnce({
      Items: [],
      $metadata: {}
    });

    const result = await healthCheck();
    const body = JSON.parse(result.body);
    
    expect(body.missedEvents[0].hoursOverdue).toBeGreaterThan(3.4);
    expect(body.missedEvents[0].hoursOverdue).toBeLessThan(3.6);
  });

  it('should detect and mark stuck events as failed for retry', async () => {
    const now = dayjs.utc();
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    
    const mockSend = vi.mocked(dynamoClient.send);
    // First call - no missed events
    mockSend.mockResolvedValueOnce({
      Items: [],
      $metadata: {}
    });
    // Second call - stuck event
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          PK: 'USER#123',
          SK: 'EVENT#birthday',
          type: 'birthday',
          date: '1990-01-15',
          sendingStatus: 'sending',
          sendingAttemptedAt: fifteenMinutesAgo
        }
      ],
      $metadata: {}
    });
    // Third call - UpdateCommand to mark as failed
    mockSend.mockResolvedValueOnce({ Attributes: {} });

    const result = await healthCheck();

    expect(result.statusCode).toBe(207); // Warning
    const body = JSON.parse(result.body);
    expect(body.status).toBe('warning');
    expect(body.stuckEventsCount).toBe(1);
    expect(body.stuckEvents[0].action).toBe('marked_failed_for_retry');
    expect(body.stuckEvents[0].minutesStuck).toBeGreaterThanOrEqual(15);
  });

  it('should monitor stuck events within timeout window', async () => {
    const now = dayjs.utc();
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    
    const mockSend = vi.mocked(dynamoClient.send);
    // First call - no missed events
    mockSend.mockResolvedValueOnce({
      Items: [],
      $metadata: {}
    });
    // Second call - stuck event but within timeout
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          PK: 'USER#456',
          SK: 'EVENT#anniversary',
          type: 'anniversary',
          date: '2010-03-20',
          sendingStatus: 'sending',
          sendingAttemptedAt: twoMinutesAgo
        }
      ],
      $metadata: {}
    });

    const result = await healthCheck();

    expect(result.statusCode).toBe(207); // Warning
    const body = JSON.parse(result.body);
    expect(body.status).toBe('warning');
    expect(body.stuckEventsCount).toBe(1);
    expect(body.stuckEvents[0].action).toBe('monitoring');
    expect(body.stuckEvents[0].minutesStuck).toBeLessThan(10);
  });

  it('should report both missed and stuck events together', async () => {
    const now = dayjs.utc();
    const twoHoursAgo = now.subtract(2, 'hours').toISOString();
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    
    const mockSend = vi.mocked(dynamoClient.send);
    // First call - 2 missed events
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          PK: 'USER#111',
          SK: 'EVENT#birthday',
          type: 'birthday',
          date: '1990-01-15',
          notifyUtc: twoHoursAgo,
          lastSentYear: 2025
        },
        {
          PK: 'USER#222',
          SK: 'EVENT#anniversary',
          type: 'anniversary',
          date: '2010-03-20',
          notifyUtc: twoHoursAgo,
          lastSentYear: 2025
        }
      ],
      $metadata: {}
    });
    // Second call - 1 stuck event
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          PK: 'USER#333',
          SK: 'EVENT#birthday',
          type: 'birthday',
          date: '1995-06-10',
          sendingStatus: 'sending',
          sendingAttemptedAt: fifteenMinutesAgo
        }
      ],
      $metadata: {}
    });
    // Third call - UpdateCommand to mark stuck as failed
    mockSend.mockResolvedValueOnce({ Attributes: {} });

    const result = await healthCheck();

    expect(result.statusCode).toBe(207); // Warning (3 total issues)
    const body = JSON.parse(result.body);
    expect(body.status).toBe('warning');
    expect(body.missedEventsCount).toBe(2);
    expect(body.stuckEventsCount).toBe(1);
    expect(body.missedEvents).toHaveLength(2);
    expect(body.stuckEvents).toHaveLength(1);
    expect(body.stuckEvents[0].action).toBe('marked_failed_for_retry');
  });
});
