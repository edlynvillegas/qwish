import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const ddbMock = mockClient(DynamoDBDocumentClient);
const mockEnqueueGreeterMessage = vi.fn();
const USERS_TABLE = 'UsersTestTable';
const SYSTEM_TIME = new Date('2026-01-15T00:00:00.000Z');
const BASE_EVENT = {
  PK: 'USER#1',
  SK: 'EVENT#birthday',
  type: 'birthday',
  date: '1990-06-15',
  notifyLocalTime: '09:00',
  lastSentYear: 0,
};
const BASE_USER = {
  id: '1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  timezone: 'UTC',
};

vi.mock('../../queues/greeter', () => ({
  enqueueGreeterMessage: (...args: any[]) => mockEnqueueGreeterMessage(...args),
}));

let scheduler: typeof import('../scheduler').scheduler;

describe('scheduler', () => {
  beforeAll(async () => {
    process.env.USERS_TABLE = USERS_TABLE;
    ({ scheduler } = await import('../scheduler'));
  });

  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(SYSTEM_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns zero counts when no events exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });

    const result = await scheduler();

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.totalUsers).toBe(0);
    expect(body.totalPages).toBe(1);
    expect(body.enqueueFailures).toBe(0);
    expect(mockEnqueueGreeterMessage).not.toHaveBeenCalled();
  });

  it('enqueues messages for events with metadata', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [BASE_EVENT],
      Count: 1,
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        data: BASE_USER,
      },
    });

    const result = await scheduler();

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.totalUsers).toBe(1);
    expect(body.enqueueFailures).toBe(0);
    expect(mockEnqueueGreeterMessage).toHaveBeenCalledWith(BASE_USER, {
      pk: BASE_EVENT.PK,
      sk: BASE_EVENT.SK,
      type: BASE_EVENT.type,
      date: BASE_EVENT.date,
      notifyLocalTime: BASE_EVENT.notifyLocalTime,
      lastSentYear: BASE_EVENT.lastSentYear,
    });
  });

  it('skips events when metadata is missing', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [BASE_EVENT],
      Count: 1,
    });
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await scheduler();

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.totalUsers).toBe(0);
    expect(body.enqueueFailures).toBe(0);
    expect(mockEnqueueGreeterMessage).not.toHaveBeenCalled();
  });

  it('tracks enqueue failures and continues', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [BASE_EVENT],
      Count: 1,
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        data: BASE_USER,
      },
    });
    mockEnqueueGreeterMessage.mockRejectedValueOnce(new Error('enqueue failed'));

    const result = await scheduler();

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.totalUsers).toBe(0);
    expect(body.enqueueFailures).toBe(1);
  });
});
