import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import dayjs from '../../lib/dayjs';

const ddbMock = mockClient(DynamoDBDocumentClient);
const USERS_TABLE = 'UsersTestTable';
const HOOKBIN_URL = 'https://hookbin.test';
const EVENT_TYPE = 'birthday';
const PK = 'USER#1';
const SK = 'EVENT#birthday';

let sender: typeof import('../sender').sender;

const mockFetch = vi.fn();

function makeSqsEvent(recordBody: object) {
  return {
    Records: [
      {
        body: JSON.stringify(recordBody),
      },
    ],
  };
}

describe('sender', () => {
  let yearNow: number;
  let eventDate: string;
  let timezone: string;
  let notifyLocalTime: string;
  let firstName: string;
  let lastName: string;

  beforeAll(async () => {
    process.env.USERS_TABLE = USERS_TABLE;
    process.env.HOOKBIN_URL = HOOKBIN_URL;
    globalThis.fetch = mockFetch as any;
    ({ sender } = await import('../sender'));
    
    yearNow = new Date().getFullYear();
    eventDate = '1990-06-15';
    timezone = 'America/New_York';
    notifyLocalTime = '09:00';
    firstName = 'Ada';
    lastName = 'Lovelace';
  });

  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockFetch.mockReset();
  });

  it('skips when event is missing', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    await sender(makeSqsEvent({
      firstName,
      lastName,
      timezone,
      notifyLocalTime,
      eventDate,
      eventType: EVENT_TYPE,
      pk: PK,
      sk: SK,
      yearNow,
    }));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('skips when event already sent this year (status: completed)', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        lastSentYear: yearNow,
        sendingStatus: 'completed',
        notifyLocalTime,
        date: eventDate,
      },
    });

    await sender(makeSqsEvent({
      firstName,
      lastName,
      timezone,
      notifyLocalTime,
      eventDate,
      eventType: EVENT_TYPE,
      pk: PK,
      sk: SK,
      yearNow,
    }));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('sends webhook and updates status through three phases', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        lastSentYear: yearNow-1,
        sendingStatus: 'pending',
        notifyLocalTime,
        date: eventDate,
      },
    });
    
    // First update (PHASE 1: claim) and second update (PHASE 3: complete)
    ddbMock.on(UpdateCommand).resolves({ Attributes: { lastSentYear: yearNow, sendingStatus: 'completed' } });
    
    mockFetch.mockResolvedValue({
      status: 200,
      json: async () => ({ ok: true }),
    });

    const record = {
      firstName,
      lastName,
      timezone,
      notifyLocalTime,
      eventDate,
      eventType: EVENT_TYPE,
      pk: PK,
      sk: SK,
      yearNow,
    };

    await sender(makeSqsEvent(record));

    expect(mockFetch).toHaveBeenCalledWith(HOOKBIN_URL, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Idempotency-Key': `${PK}-${EVENT_TYPE}-${yearNow}`
      },
      body: JSON.stringify({ message: `Hey ${firstName} ${lastName}, it's your ${EVENT_TYPE}!` }),
    });

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(2); // PHASE 1: claim, PHASE 3: complete
    
    // Check PHASE 1 (claim) - first update
    const claimInput = calls[0]?.args[0]?.input;
    expect(claimInput?.ExpressionAttributeValues?.[':sending']).toBe('sending');
    expect(claimInput?.ExpressionAttributeValues?.[':year']).toBe(yearNow);
    expect(claimInput?.ExpressionAttributeValues?.[':currentLastSentYear']).toBe(yearNow-1);
    
    // Check PHASE 3 (complete) - second update
    const completeInput = calls[1]?.args[0]?.input;
    expect(completeInput?.ExpressionAttributeValues?.[':completed']).toBe('completed');
  });

  it('continues when conditional claim fails (another Lambda claimed first)', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        lastSentYear: yearNow-1,
        sendingStatus: 'pending',
        notifyLocalTime,
        date: eventDate,
      },
    });
    ddbMock.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} })
    );
    mockFetch.mockResolvedValue({
      status: 200,
      json: async () => ({ ok: true }),
    });

    await sender(makeSqsEvent({
      firstName,
      lastName,
      timezone,
      notifyLocalTime,
      eventDate,
      eventType: EVENT_TYPE,
      pk: PK,
      sk: SK,
      yearNow,
    }));

    // Only one UpdateCommand (PHASE 1 claim attempt) - fails and continues
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
    // Webhook should NOT be called since claim failed
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws when webhook fails and marks as failed', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        lastSentYear: yearNow-1,
        sendingStatus: 'pending',
        notifyLocalTime,
        date: eventDate,
      },
    });
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });
    mockFetch.mockResolvedValue({
      status: 500,
      json: async () => ({ ok: false }),
    });

    await expect(sender(makeSqsEvent({
      firstName,
      lastName,
      timezone,
      notifyLocalTime,
      eventDate,
      eventType: EVENT_TYPE,
      pk: PK,
      sk: SK,
      yearNow,
    }))).rejects.toThrow(`Failed to send message to Hookbin for user ${firstName} ${lastName}`);
    
    // Should have tried to mark as failed (PHASE 1 claim + failed status update)
    expect(ddbMock.commandCalls(UpdateCommand).length).toBeGreaterThanOrEqual(2);
  });

  it('skips event stuck in sending state (within timeout)', async () => {
    const recentTime = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 minutes ago
    
    ddbMock.on(GetCommand).resolves({
      Item: {
        lastSentYear: yearNow,
        sendingStatus: 'sending',
        sendingAttemptedAt: recentTime,
        notifyLocalTime,
        date: eventDate,
      },
    });

    await sender(makeSqsEvent({
      firstName,
      lastName,
      timezone,
      notifyLocalTime,
      eventDate,
      eventType: EVENT_TYPE,
      pk: PK,
      sk: SK,
      yearNow,
    }));

    // Should skip - another Lambda is processing
    expect(mockFetch).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('marks stuck event as failed and retries (timeout exceeded)', async () => {
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
    
    ddbMock.on(GetCommand).resolves({
      Item: {
        lastSentYear: yearNow - 1,
        sendingStatus: 'sending',
        sendingAttemptedAt: oldTime,
        notifyLocalTime,
        date: eventDate,
      },
    });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { lastSentYear: yearNow, sendingStatus: 'completed' } });
    mockFetch.mockResolvedValue({
      status: 200,
      json: async () => ({ ok: true }),
    });

    await sender(makeSqsEvent({
      firstName,
      lastName,
      timezone,
      notifyLocalTime,
      eventDate,
      eventType: EVENT_TYPE,
      pk: PK,
      sk: SK,
      yearNow,
    }));

    // Should mark as failed, then retry the message (claim + complete)
    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls.length).toBeGreaterThanOrEqual(3); // Mark failed + Claim + Complete
    
    // First update should mark as failed
    const firstUpdate = calls[0]?.args[0]?.input;
    expect(firstUpdate?.ExpressionAttributeValues?.[':failed']).toBe('failed');
    expect(firstUpdate?.ExpressionAttributeValues?.[':reason']).toContain('Stuck in sending state');
    
    // Webhook should be called
    expect(mockFetch).toHaveBeenCalled();
  });
});
