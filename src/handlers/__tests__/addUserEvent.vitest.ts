import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { USER_EVENT_NAMES } from '../../constants/userEventNames';

const ddbMock = mockClient(DynamoDBDocumentClient);
const USERS_TABLE = 'UsersTestTable';
const USER_ID = '123';
const EVENT_DATE = '1990-06-15';
const NOTIFY_LOCAL_TIME = '09:00';
const NOTIFY_UTC_YEAR = new Date().getFullYear();
const DEFAULT_NOTIFY_UTC = `${NOTIFY_UTC_YEAR}-06-15T13:00:00.000Z`;
const mockComputeNotifyUtc = vi.fn();

vi.mock('../../utils/notify', () => ({
  computeNotifyUtc: (...args: any[]) => mockComputeNotifyUtc(...args),
}));

function makeAddEvent(
  userId?: string,
  body: object | null = null
): APIGatewayProxyEvent {
  return {
    body: body ? JSON.stringify(body) : null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: `/users/${userId ?? ''}/events`,
    pathParameters: userId ? { id: userId } : null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
  };
}

let addUserEvent: typeof import('../addUserEvent').addUserEvent;

describe('addUserEvent', () => {
  beforeAll(async () => {
    process.env.USERS_TABLE = USERS_TABLE;
    ({ addUserEvent } = await import('../addUserEvent'));
  });

  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    mockComputeNotifyUtc.mockReturnValue(DEFAULT_NOTIFY_UTC);
  });

  it('returns 400 when user id is missing', async () => {
    const result = await addUserEvent(makeAddEvent()) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('User id is required');
  });

  it('returns 400 for invalid payload', async () => {
    const result = await addUserEvent(
      makeAddEvent(USER_ID, {})
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBeDefined();
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('returns 404 when user does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await addUserEvent(
      makeAddEvent(USER_ID, { type: USER_EVENT_NAMES.BIRTHDAY, date: EVENT_DATE })
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe(`User ${USER_ID} not found`);
  });

  it('returns 409 when event already exists', async () => {
    ddbMock.on(GetCommand)
      .resolvesOnce({ Item: { data: { id: USER_ID, firstName: 'Jane', lastName: 'Doe', timezone: 'UTC' } } })
      .resolvesOnce({ Item: { PK: `USER#${USER_ID}`, SK: 'EVENT#birthday' } });

    const result = await addUserEvent(
      makeAddEvent(USER_ID, { type: USER_EVENT_NAMES.BIRTHDAY, date: EVENT_DATE })
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error).toBe('Event birthday already exists for user Jane Doe');
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('adds a new event successfully', async () => {
    ddbMock.on(GetCommand)
      .resolvesOnce({ Item: { data: { id: USER_ID, firstName: 'Jane', lastName: 'Doe', timezone: 'America/New_York' } } })
      .resolvesOnce({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const result = await addUserEvent(
      makeAddEvent(USER_ID, { type: USER_EVENT_NAMES.BIRTHDAY, date: '1990-6-15', notifyLocalTime: NOTIFY_LOCAL_TIME, label: 'Party' })
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.message).toBe('Event added successfully');
    expect(body.data).toMatchObject({
      type: 'birthday',
      date: EVENT_DATE,
      notifyLocalTime: NOTIFY_LOCAL_TIME,
      notifyUtc: DEFAULT_NOTIFY_UTC,
      lastSentYear: 0,
      label: 'Party',
    });
    expect(body.data.createdAt).toBeDefined();
    expect(body.data.updatedAt).toBeDefined();

    expect(mockComputeNotifyUtc).toHaveBeenCalledWith(
      EVENT_DATE,
      'America/New_York',
      NOTIFY_LOCAL_TIME,
      expect.any(String)
    );

    const calls = ddbMock.commandCalls(PutCommand);
    const input = calls[0]?.args[0]?.input;
    expect(input?.ConditionExpression).toBe('attribute_not_exists(PK) AND attribute_not_exists(SK)');
    expect(input?.Item?.GSI1PK).toBe('EVENT');
  });

  it('returns 409 when conditional check fails', async () => {
    ddbMock.on(GetCommand)
      .resolvesOnce({ Item: { data: { id: USER_ID, firstName: 'Jane', lastName: 'Doe', timezone: 'UTC' } } })
      .resolvesOnce({ Item: undefined });
    ddbMock.on(PutCommand).rejects(
      new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} })
    );

    const result = await addUserEvent(
      makeAddEvent(USER_ID, { type: USER_EVENT_NAMES.BIRTHDAY, date: EVENT_DATE })
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error).toBe(`Error adding event birthday for user ${USER_ID}`);
  });

  it('rethrows unexpected errors', async () => {
    ddbMock.on(GetCommand).rejects(new Error('boom'));

    await expect(
      addUserEvent(makeAddEvent(USER_ID, { type: USER_EVENT_NAMES.BIRTHDAY, date: EVENT_DATE }))
    ).rejects.toThrow('boom');
  });
});
