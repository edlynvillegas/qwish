import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';
import type { APIGatewayProxyResult, APIGatewayProxyEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { USER_EVENT_NAMES } from '../../constants/userEventNames';

// Create DynamoDB mock
const ddbMock = mockClient(DynamoDBDocumentClient);

// Mock functions
const mockComputeNotifyUtc = vi.fn();
const mockFlattenUserToDynamoDBItems = vi.fn();
const mockUuidv4 = vi.fn();

// Mock uuid
vi.mock('uuid', () => ({
  v4: () => mockUuidv4(),
}));

// Mock local modules
vi.mock('../../utils/notify', () => ({
  computeNotifyUtc: (...args: any[]) => mockComputeNotifyUtc(...args),
}));

vi.mock('../../utils/flattenUserToDynamoDBItems', () => ({
  flattenUserToDynamoDBItems: (...args: any[]) => mockFlattenUserToDynamoDBItems(...args),
}));

// Helper for typed event
function makeAPIGatewayEvent(body: object): APIGatewayProxyEvent {
  return {
    body: JSON.stringify(body),
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/users',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
  };
}

let createUser: typeof import('../createUser').createUser;

describe('createUser', () => {

  beforeAll(async () => {
    process.env.USERS_TABLE = 'UsersTestTable';
    ({ createUser } = await import('../createUser'));
  });
  
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    
    // Mock DynamoDB BatchWriteCommand
    ddbMock.on(BatchWriteCommand).resolves({});
    
    // Mock other dependencies with default values
    mockUuidv4.mockReturnValue('test-uuid-123');
    mockComputeNotifyUtc.mockReturnValue('2026-06-15T13:00:00.000Z');
  });

  describe('Successful user creation', () => {
    it('should create user with single event', async () => {
      const mockEvent = {
        type: USER_EVENT_NAMES.BIRTHDAY,
        date: '1990-06-15',
        notifyLocalTime: '09:00',
      };

      const mockDynamoItems = [
        { PK: 'USER#test-uuid-123', SK: 'METADATA', data: { id: 'test-uuid-123', firstName: 'John', lastName: 'Doe', timezone: 'America/New_York' } },
        { PK: 'USER#test-uuid-123', SK: 'EVENT#birthday', type: 'birthday', date: '1990-06-15', notifyLocalTime: '09:00', notifyUtc: '2026-06-15T13:00:00.000Z', lastSentYear: 0, GSI1PK: 'EVENT' },
      ];

      mockFlattenUserToDynamoDBItems.mockReturnValue(mockDynamoItems);

      const event = makeAPIGatewayEvent({ firstName: 'John', lastName: 'Doe', timezone: 'America/New_York', events: [mockEvent] });
      const result = await createUser(event) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(201);
      const responseBody = JSON.parse(result.body);
      expect(responseBody.id).toBe('test-uuid-123');
      expect(responseBody.firstName).toBe('John');
      expect(responseBody.lastName).toBe('Doe');
      expect(responseBody.timezone).toBe('America/New_York');
      expect(responseBody.events).toHaveLength(1);
      expect(responseBody.events[0].type).toBe('birthday');
      expect(responseBody.events[0].date).toBe('1990-06-15');
      expect(responseBody.events[0].notifyLocalTime).toBe('09:00');
      expect(responseBody.events[0].lastSentYear).toBe(0);

      // Verify DynamoDB write
      expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(1);

      // Verify computeNotifyUtc was called with correct parameters
      expect(mockComputeNotifyUtc).toHaveBeenCalledWith('1990-06-15', 'America/New_York', '09:00');
    });

    it('should create user with multiple events', async () => {
      const mockEvents = [
        { type: USER_EVENT_NAMES.BIRTHDAY, date: '1990-06-15', notifyLocalTime: '09:00' },
        { type: USER_EVENT_NAMES.ANNIVERSARY, date: '2020-06-10', notifyLocalTime: '10:00', label: 'Wedding' },
      ];

      const mockDynamoItems = [
        { PK: 'USER#test-uuid-123', SK: 'METADATA', data: { id: 'test-uuid-123', firstName: 'Jane', lastName: 'Smith', timezone: 'UTC' } },
        { PK: 'USER#test-uuid-123', SK: 'EVENT#birthday', type: 'birthday', date: '1990-06-15', notifyLocalTime: '09:00', notifyUtc: '2026-06-15T09:00:00.000Z', lastSentYear: 0, GSI1PK: 'EVENT' },
        { PK: 'USER#test-uuid-123', SK: 'EVENT#anniversary', type: 'anniversary', date: '2020-06-10', notifyLocalTime: '10:00', notifyUtc: '2026-06-10T10:00:00.000Z', lastSentYear: 0, GSI1PK: 'EVENT', label: 'Wedding' },
      ];

      mockFlattenUserToDynamoDBItems.mockReturnValue(mockDynamoItems);
      mockComputeNotifyUtc
        .mockReturnValueOnce('2026-06-15T09:00:00.000Z')
        .mockReturnValueOnce('2026-06-10T10:00:00.000Z');

      const event = makeAPIGatewayEvent({ firstName: 'Jane', lastName: 'Smith', timezone: 'UTC', events: mockEvents });
      const result = await createUser(event) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(201);
      const responseBody = JSON.parse(result.body);
      expect(responseBody.events).toHaveLength(2);
      expect(responseBody.events[0].type).toBe('birthday');
      expect(responseBody.events[1].type).toBe('anniversary');
      expect(responseBody.events[1].label).toBe('Wedding');

      // Verify computeNotifyUtc called for each event
      expect(mockComputeNotifyUtc).toHaveBeenCalledTimes(2);
      expect(mockComputeNotifyUtc).toHaveBeenNthCalledWith(1, '1990-06-15', 'UTC', '09:00');
      expect(mockComputeNotifyUtc).toHaveBeenNthCalledWith(2, '2020-06-10', 'UTC', '10:00');
    });

    it('should use default notifyLocalTime when not provided', async () => {
      const mockEvent = {
        type: USER_EVENT_NAMES.BIRTHDAY,
        date: '1990-06-15',
        // notifyLocalTime not provided
      };

      const mockDynamoItems = [
        { PK: 'USER#test-uuid-123', SK: 'METADATA', data: {} },
        { PK: 'USER#test-uuid-123', SK: 'EVENT#birthday', type: 'birthday', date: '1990-06-15', notifyLocalTime: '09:00', notifyUtc: '2026-06-15T13:00:00.000Z', lastSentYear: 0, GSI1PK: 'EVENT' },
      ];

      mockFlattenUserToDynamoDBItems.mockReturnValue(mockDynamoItems);

      const event = makeAPIGatewayEvent({ firstName: 'John', lastName: 'Doe', timezone: 'America/New_York', events: [mockEvent] });
      const result = await createUser(event) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(201);

      // Verify default notifyLocalTime was used (09:00)
      expect(mockComputeNotifyUtc).toHaveBeenCalledWith('1990-06-15', 'America/New_York', '09:00');
    });

    it('should normalize date format', async () => {
      const mockEvent = {
        type: USER_EVENT_NAMES.BIRTHDAY,
        date: '1990-6-15', // Not normalized
        notifyLocalTime: '09:00',
      };

      const mockDynamoItems = [
        { PK: 'USER#test-uuid-123', SK: 'METADATA', data: {} },
        { PK: 'USER#test-uuid-123', SK: 'EVENT#birthday', type: 'birthday', date: '1990-06-15', notifyLocalTime: '09:00', notifyUtc: '2026-06-15T13:00:00.000Z', lastSentYear: 0, GSI1PK: 'EVENT' },
      ];

      mockFlattenUserToDynamoDBItems.mockReturnValue(mockDynamoItems);

      const event = makeAPIGatewayEvent({ firstName: 'John', lastName: 'Doe', timezone: 'UTC', events: [mockEvent] });
      const result = await createUser(event) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(201);

      // Verify date was normalized to YYYY-MM-DD format
      expect(mockComputeNotifyUtc).toHaveBeenCalledWith('1990-06-15', 'UTC', '09:00');
    });

    it('should include event label when provided', async () => {
      const mockEvent = {
        type: USER_EVENT_NAMES.ANNIVERSARY,
        date: '2020-06-10',
        notifyLocalTime: '10:00',
        label: 'Work Anniversary',
      };

      const mockDynamoItems = [
        { PK: 'USER#test-uuid-123', SK: 'METADATA', data: {} },
        { PK: 'USER#test-uuid-123', SK: 'EVENT#anniversary', type: 'anniversary', date: '2020-06-10', notifyLocalTime: '10:00', notifyUtc: '2026-06-10T10:00:00.000Z', lastSentYear: 0, GSI1PK: 'EVENT', label: 'Work Anniversary' },
      ];

      mockFlattenUserToDynamoDBItems.mockReturnValue(mockDynamoItems);

      const event = makeAPIGatewayEvent({ firstName: 'John', lastName: 'Doe', timezone: 'UTC', events: [mockEvent] });
      const result = await createUser(event) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(201);
      const responseBody = JSON.parse(result.body);

      expect(responseBody.events[0].label).toBe('Work Anniversary');
    });

    it('should not include label when not provided', async () => {
      const mockEvent = {
        type: USER_EVENT_NAMES.BIRTHDAY,
        date: '1990-06-15',
        notifyLocalTime: '09:00',
        // No label
      };

      const mockDynamoItems = [
        { PK: 'USER#test-uuid-123', SK: 'METADATA', data: {} },
        { PK: 'USER#test-uuid-123', SK: 'EVENT#birthday', type: 'birthday', date: '1990-06-15', notifyLocalTime: '09:00', notifyUtc: '2026-06-15T13:00:00.000Z', lastSentYear: 0, GSI1PK: 'EVENT' },
      ];

      mockFlattenUserToDynamoDBItems.mockReturnValue(mockDynamoItems);

      const event = makeAPIGatewayEvent({ firstName: 'John', lastName: 'Doe', timezone: 'UTC', events: [mockEvent] });
      const result = await createUser(event) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(201);
      const responseBody = JSON.parse(result.body);

      expect(responseBody.events[0].label).toBeUndefined();
    });
  });

  describe('Batch writing', () => {
    it('should write items in batches of 25', async () => {
      // Create 30 events to trigger multiple batches
      const events = Array.from({ length: 30 }, (_, i) => ({
        type: i % 2 === 0 ? USER_EVENT_NAMES.BIRTHDAY : USER_EVENT_NAMES.ANNIVERSARY,
        date: `1990-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
        notifyLocalTime: '09:00',
      }));

      // 1 metadata + 30 events = 31 items total
      // Should be split into 2 batches: 25 + 6
      const mockDynamoItems = Array.from({ length: 31 }, (_, i) => {
        if (i === 0) {
          return { PK: 'USER#test-uuid-123', SK: 'METADATA', data: {} };
        }
        return {
          PK: 'USER#test-uuid-123',
          SK: `EVENT#event-${i}`,
          type: i % 2 === 0 ? 'birthday' : 'anniversary',
          date: `1990-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
          notifyLocalTime: '09:00',
          notifyUtc: '2026-01-01T09:00:00.000Z',
          lastSentYear: 0,
          GSI1PK: 'EVENT',
        };
      });

      mockFlattenUserToDynamoDBItems.mockReturnValue(mockDynamoItems);
      mockComputeNotifyUtc.mockReturnValue('2026-01-01T09:00:00.000Z');

      const event = makeAPIGatewayEvent({ firstName: 'John', lastName: 'Doe', timezone: 'UTC', events });
      const result = await createUser(event) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(201);

      // Should be called twice: once for 25 items, once for 6 items
      const calls = ddbMock.commandCalls(BatchWriteCommand);
      expect(calls).toHaveLength(2);
    });

    it('should write single batch when items <= 25', async () => {
      const mockEvent = {
        type: USER_EVENT_NAMES.BIRTHDAY,
        date: '1990-06-15',
        notifyLocalTime: '09:00',
      };

      const mockDynamoItems = [
        { PK: 'USER#test-uuid-123', SK: 'METADATA', data: {} },
        { PK: 'USER#test-uuid-123', SK: 'EVENT#birthday', type: 'birthday', date: '1990-06-15', notifyLocalTime: '09:00', notifyUtc: '2026-06-15T13:00:00.000Z', lastSentYear: 0, GSI1PK: 'EVENT' },
      ];

      mockFlattenUserToDynamoDBItems.mockReturnValue(mockDynamoItems);

      const event = makeAPIGatewayEvent({ firstName: 'John', lastName: 'Doe', timezone: 'UTC', events: [mockEvent] });
      const result = await createUser(event) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(201);

      // Should be called once
      const calls = ddbMock.commandCalls(BatchWriteCommand);
      expect(calls).toHaveLength(1);
    });
  });

  describe('Validation errors', () => {
    it('should return 400 for invalid payload (empty firstName)', async () => {
      const event = makeAPIGatewayEvent({ firstName: '', lastName: 'Doe', timezone: 'UTC', events: [{ type: 'birthday', date: '1990-06-15' }] });

      const result = await createUser(event) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(400);
      const responseBody = JSON.parse(result.body);
      expect(responseBody.error).toBeDefined();
      expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    });

    it('should return 400 for missing required fields (lastName)', async () => {
      const event = makeAPIGatewayEvent({ firstName: 'John', events: [{ type: 'birthday', date: '1990-06-15' }] });

      const result = await createUser(event) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(400);
      expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    });

    it('should return 400 for empty events array', async () => {
      const event = makeAPIGatewayEvent({ firstName: 'John', lastName: 'Doe', timezone: 'UTC', events: [] });

      const result = await createUser(event) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(400);
      expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    });

    it('should return 400 for invalid timezone', async () => {
      const event = makeAPIGatewayEvent({ firstName: 'John', lastName: 'Doe', timezone: 'Invalid/Timezone', events: [{ type: 'birthday', date: '1990-06-15' }] });

      const result = await createUser(event) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(400);
      expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    });

    it('should return 400 for invalid event type', async () => {
      const event = makeAPIGatewayEvent({ firstName: 'John', lastName: 'Doe', timezone: 'UTC', events: [{ type: 'invalid-type', date: '1990-06-15' }] });

      const result = await createUser(event) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(400);
      expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    });

    it('should return 400 for invalid notifyLocalTime format', async () => {
      const event = makeAPIGatewayEvent({ firstName: 'John', lastName: 'Doe', timezone: 'UTC', events: [{ type: 'birthday', date: '1990-06-15', notifyLocalTime: '25:00' }] });

      const result = await createUser(event) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(400);
      expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    });
  });

  describe('Event processing', () => {
    it('should set lastSentYear to 0 for all events', async () => {
      const mockEvent = {
        type: USER_EVENT_NAMES.BIRTHDAY,
        date: '1990-06-15',
        notifyLocalTime: '09:00',
      };

      const mockDynamoItems = [
        { PK: 'USER#test-uuid-123', SK: 'METADATA', data: {} },
        { PK: 'USER#test-uuid-123', SK: 'EVENT#birthday', type: 'birthday', date: '1990-06-15', notifyLocalTime: '09:00', notifyUtc: '2026-06-15T13:00:00.000Z', lastSentYear: 0, GSI1PK: 'EVENT' },
      ];

      mockFlattenUserToDynamoDBItems.mockReturnValue(mockDynamoItems);

      const event = makeAPIGatewayEvent({ firstName: 'John', lastName: 'Doe', timezone: 'UTC', events: [mockEvent] });

      const result = await createUser(event) as APIGatewayProxyResult;
      const responseBody = JSON.parse(result.body);

      expect(responseBody.events[0].lastSentYear).toBe(0);
    });

    it('should compute notifyUtc for each event', async () => {
      const mockEvents = [
        { type: USER_EVENT_NAMES.BIRTHDAY, date: '1990-06-15', notifyLocalTime: '09:00' },
        { type: USER_EVENT_NAMES.ANNIVERSARY, date: '2020-12-25', notifyLocalTime: '12:00' },
      ];

      const mockDynamoItems = [
        { PK: 'USER#test-uuid-123', SK: 'METADATA', data: {} },
        { PK: 'USER#test-uuid-123', SK: 'EVENT#birthday', type: 'birthday', date: '1990-06-15', notifyLocalTime: '09:00', notifyUtc: '2026-06-15T13:00:00.000Z', lastSentYear: 0, GSI1PK: 'EVENT' },
        { PK: 'USER#test-uuid-123', SK: 'EVENT#anniversary', type: 'anniversary', date: '2020-12-25', notifyLocalTime: '12:00', notifyUtc: '2026-12-25T12:00:00.000Z', lastSentYear: 0, GSI1PK: 'EVENT' },
      ];

      mockFlattenUserToDynamoDBItems.mockReturnValue(mockDynamoItems);
      mockComputeNotifyUtc
        .mockReturnValueOnce('2026-06-15T13:00:00.000Z')
        .mockReturnValueOnce('2026-12-25T12:00:00.000Z');

      const event = makeAPIGatewayEvent({ firstName: 'John', lastName: 'Doe', timezone: 'America/New_York', events: mockEvents });

      const result = await createUser(event) as APIGatewayProxyResult;
      expect(result.statusCode).toBe(201);

      expect(mockComputeNotifyUtc).toHaveBeenCalledTimes(2);
      expect(mockComputeNotifyUtc).toHaveBeenNthCalledWith(1, '1990-06-15', 'America/New_York', '09:00');
      expect(mockComputeNotifyUtc).toHaveBeenNthCalledWith(2, '2020-12-25', 'America/New_York', '12:00');
    });
  });

  describe('Response format', () => {
    it('should return user with generated UUID', async () => {
      const mockEvent = {
        type: USER_EVENT_NAMES.BIRTHDAY,
        date: '1990-06-15',
        notifyLocalTime: '09:00',
      };

      const mockDynamoItems = [
        { PK: 'USER#test-uuid-123', SK: 'METADATA', data: { id: 'test-uuid-123', firstName: 'John', lastName: 'Doe', timezone: 'UTC' } },
        { PK: 'USER#test-uuid-123', SK: 'EVENT#birthday', type: 'birthday', date: '1990-06-15', notifyLocalTime: '09:00', notifyUtc: '2026-06-15T13:00:00.000Z', lastSentYear: 0, GSI1PK: 'EVENT' },
      ];

      mockFlattenUserToDynamoDBItems.mockReturnValue(mockDynamoItems);

      const event = makeAPIGatewayEvent({ firstName: 'John', lastName: 'Doe', timezone: 'UTC', events: [mockEvent] });

      const result = await createUser(event) as APIGatewayProxyResult;
      const responseBody = JSON.parse(result.body);

      expect(responseBody.id).toBe('test-uuid-123');
    });

    it('should return status code 201 on success', async () => {
      const mockEvent = {
        type: USER_EVENT_NAMES.BIRTHDAY,
        date: '1990-06-15',
        notifyLocalTime: '09:00',
      };

      const mockDynamoItems = [
        { PK: 'USER#test-uuid-123', SK: 'METADATA', data: {} },
        { PK: 'USER#test-uuid-123', SK: 'EVENT#birthday', type: 'birthday', date: '1990-06-15', notifyLocalTime: '09:00', notifyUtc: '2026-06-15T13:00:00.000Z', lastSentYear: 0, GSI1PK: 'EVENT' },
      ];

      mockFlattenUserToDynamoDBItems.mockReturnValue(mockDynamoItems);

      const event = makeAPIGatewayEvent({ firstName: 'John', lastName: 'Doe', timezone: 'UTC', events: [mockEvent] });
      const result = await createUser(event) as APIGatewayProxyResult;

      expect(result.statusCode).toBe(201);
    });

    it('should return complete user object with all fields', async () => {
      const mockEvent = {
        type: USER_EVENT_NAMES.BIRTHDAY,
        date: '1990-06-15',
        notifyLocalTime: '09:00',
      };

      const mockDynamoItems = [
        { PK: 'USER#test-uuid-123', SK: 'METADATA', data: { id: 'test-uuid-123', firstName: 'John', lastName: 'Doe', timezone: 'America/New_York' } },
        { PK: 'USER#test-uuid-123', SK: 'EVENT#birthday', type: 'birthday', date: '1990-06-15', notifyLocalTime: '09:00', notifyUtc: '2026-06-15T13:00:00.000Z', lastSentYear: 0, GSI1PK: 'EVENT' },
      ];

      mockFlattenUserToDynamoDBItems.mockReturnValue(mockDynamoItems);

      const event = makeAPIGatewayEvent({ firstName: 'John', lastName: 'Doe', timezone: 'America/New_York', events: [mockEvent] });
      const result = await createUser(event) as APIGatewayProxyResult;
      const responseBody = JSON.parse(result.body);

      expect(responseBody).toEqual({
        id: 'test-uuid-123',
        firstName: 'John',
        lastName: 'Doe',
        timezone: 'America/New_York',
        events: [
          {
            type: 'birthday',
            date: '1990-06-15',
            notifyLocalTime: '09:00',
            notifyUtc: '2026-06-15T13:00:00.000Z',
            lastSentYear: 0,
          },
        ],
      });
    });
  });
});
