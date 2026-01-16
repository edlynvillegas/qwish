import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

function makeUpdateEvent(
  userId?: string,
  body: object | null = null
): APIGatewayProxyEvent {
  return {
    body: body ? JSON.stringify(body) : null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'PATCH',
    isBase64Encoded: false,
    path: `/users/${userId ?? ''}`,
    pathParameters: userId ? { id: userId } : null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
  };
}

let updateUser: typeof import('../updateUser').updateUser;

describe('updateUser', () => {
  beforeAll(async () => {
    process.env.USERS_TABLE = USERS_TABLE;
    ({ updateUser } = await import('../updateUser'));
  });

  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    mockComputeNotifyUtc.mockReturnValue(DEFAULT_NOTIFY_UTC);
  });

  it('returns 400 when id is missing', async () => {
    const result = await updateUser(makeUpdateEvent()) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('ID is required');
  });

  it('returns 400 when events are missing type', async () => {
    const result = await updateUser(
      makeUpdateEvent(USER_ID, { events: [{}] })
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error).toBe('Failed to update events');
    expect(body.details).toContain('Event type is required for all events');
  });

  it('updates event fields and recomputes notifyUtc', async () => {
    ddbMock.on(GetCommand)
      .resolvesOnce({ Item: { PK: `USER#${USER_ID}`, SK: 'EVENT#birthday', date: '1990-01-01', notifyLocalTime: '08:00' } })
      .resolvesOnce({ Item: { data: { id: USER_ID, firstName: 'Jane', lastName: 'Doe', timezone: 'America/New_York' } } });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: {
        type: 'birthday',
        date: EVENT_DATE,
        notifyLocalTime: NOTIFY_LOCAL_TIME,
        notifyUtc: DEFAULT_NOTIFY_UTC,
        lastSentYear: 0,
        label: 'Party',
      },
    });

    const result = await updateUser(
      makeUpdateEvent(USER_ID, {
        events: [
          {
            type: USER_EVENT_NAMES.BIRTHDAY,
            date: '1990-6-15',
            notifyLocalTime: NOTIFY_LOCAL_TIME,
            label: 'Party',
          },
        ],
      })
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].type).toBe('birthday');
    expect(body.data[0].data).toMatchObject({
      date: EVENT_DATE,
      notifyLocalTime: NOTIFY_LOCAL_TIME,
      notifyUtc: '2026-06-15T13:00:00.000Z',
      label: 'Party',
    });

    expect(mockComputeNotifyUtc).toHaveBeenCalledWith(
      EVENT_DATE,
      'America/New_York',
      NOTIFY_LOCAL_TIME
    );

    const calls = ddbMock.commandCalls(UpdateCommand);
    const input = calls[0]?.args[0]?.input;
    expect(input?.UpdateExpression).toContain('notifyUtc = :notifyUtc');
    expect(input?.ExpressionAttributeValues?.[':notifyUtc']).toBe('2026-06-15T13:00:00.000Z');
  });

  it('returns 400 when no fields to update', async () => {
    const result = await updateUser(
      makeUpdateEvent(USER_ID, {})
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('No fields to update');
  });

  it('updates user metadata', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { data: { id: USER_ID, firstName: 'Old', lastName: 'Name', timezone: 'UTC' } } });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { data: { id: USER_ID, firstName: 'New', lastName: 'Name', timezone: 'UTC' } } });

    const result = await updateUser(
      makeUpdateEvent(USER_ID, { firstName: 'New' })
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data).toEqual({ id: USER_ID, firstName: 'New', lastName: 'Name', timezone: 'UTC' });

    const calls = ddbMock.commandCalls(UpdateCommand);
    const input = calls[0]?.args[0]?.input;
    expect(input?.UpdateExpression).toContain('#data.#firstName = :firstName');
  });

  it('returns 404 when user metadata missing', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await updateUser(
      makeUpdateEvent(USER_ID, { firstName: 'New' })
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe(`User with id ${USER_ID} not found`);
  });

  it('returns 404 when conditional check fails', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { data: { id: USER_ID, firstName: 'Old', lastName: 'Name', timezone: 'UTC' } } });
    ddbMock.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({ message: 'condition failed', $metadata: {} })
    );

    const result = await updateUser(
      makeUpdateEvent(USER_ID, { firstName: 'New' })
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe(`User with id ${USER_ID} not found`);
  });
});
