import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { UserEventName } from '../../constants/userEventNames';

const mockGetQueueUrl = vi.fn();
const mockSend = vi.fn();
const QUEUE_NAME = 'GreeterQueue';
const QUEUE_URL = 'https://sqs.local/greeter';
const SYSTEM_TIME = new Date('2026-01-15T12:00:00.000Z');
const YEAR_NOW = SYSTEM_TIME.getFullYear();
const EVENT_TYPE_BIRTHDAY = 'birthday';
const EVENT_TYPE_ANNIVERSARY = 'anniversary';
const USER_1 = {
  id: 'user-1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  timezone: 'UTC',
};
const USER_2 = {
  id: 'user-2',
  firstName: 'Grace',
  lastName: 'Hopper',
  timezone: 'UTC',
};
const EVENT_DATE = '1990-06-15';
const NOTIFY_LOCAL_TIME = '09:00';

vi.mock('../../lib/sqs', () => ({
  getQueueUrl: (...args: any[]) => mockGetQueueUrl(...args),
  sqsClient: { send: (...args: any[]) => mockSend(...args) },
}));

let enqueueGreeterMessage: typeof import('../greeter').enqueueGreeterMessage;

describe('enqueueGreeterMessage', () => {
  beforeAll(async () => {
    process.env.GREETER_QUEUE_NAME = QUEUE_NAME;
    ({ enqueueGreeterMessage } = await import('../greeter'));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SYSTEM_TIME);
    mockGetQueueUrl.mockResolvedValue(QUEUE_URL);
    mockSend.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('sends a message with expected payload and headers', async () => {
    const user = USER_1;
    const event = {
      pk: `USER#${USER_1.id}`,
      sk: `EVENT#${EVENT_TYPE_BIRTHDAY}`,
      type: EVENT_TYPE_BIRTHDAY as UserEventName,
      date: EVENT_DATE,
      notifyLocalTime: NOTIFY_LOCAL_TIME,
      lastSentYear: YEAR_NOW - 1,
    };

    await enqueueGreeterMessage(user, event);

    expect(mockGetQueueUrl).toHaveBeenCalledWith(QUEUE_NAME);
    expect(mockSend).toHaveBeenCalledTimes(1);

    const command = mockSend.mock.calls[0]?.[0] as SendMessageCommand;
    const input = command.input;
    const messageBody = JSON.parse(input.MessageBody as string);

    expect(messageBody).toEqual({
      ...user,
      pk: event.pk,
      sk: event.sk,
      eventType: event.type,
      eventDate: event.date,
      notifyLocalTime: event.notifyLocalTime,
      lastSentYear: event.lastSentYear,
      yearNow: YEAR_NOW,
    });
    expect(input.QueueUrl).toBe(QUEUE_URL);
    expect(input.MessageGroupId).toBe(EVENT_TYPE_BIRTHDAY);
    expect(input.MessageDeduplicationId).toBe(`${USER_1.id}-${EVENT_TYPE_BIRTHDAY}-${YEAR_NOW}`);
  });

  it('defaults lastSentYear to 0 when missing', async () => {
    const user = USER_2;
    const event = {
      pk: `USER#${USER_2.id}`,
      sk: `EVENT#${EVENT_TYPE_ANNIVERSARY}`,
      type: EVENT_TYPE_ANNIVERSARY as UserEventName,
      date: '2000-12-01',
      notifyLocalTime: '10:00',
      lastSentYear: undefined as unknown as number,
    };

    await enqueueGreeterMessage(user, event);

    const command = mockSend.mock.calls[0]?.[0] as SendMessageCommand;
    const messageBody = JSON.parse(command.input.MessageBody as string);

    expect(messageBody.lastSentYear).toBe(0);
  });
});
