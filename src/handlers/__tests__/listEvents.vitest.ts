import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { USER_EVENT_NAMES } from '../../constants/userEventNames';

const ddbMock = mockClient(DynamoDBDocumentClient);
const USERS_TABLE = 'UsersTestTable';

function makeListEvent(
  queryStringParameters: Record<string, string> | null = null
): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/events',
    pathParameters: null,
    queryStringParameters,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
  };
}

let listEvents: typeof import('../listEvents').listEvents;

describe('listEvents', () => {
  beforeAll(async () => {
    process.env.USERS_TABLE = USERS_TABLE;
    ({ listEvents } = await import('../listEvents'));
  });

  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
  });

  it('returns events with default page size', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ id: '1', type: 'birthday' }],
      Count: 1,
    });

    const result = await listEvents(makeListEvent()) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data).toEqual([{ id: '1', type: 'birthday' }]);
    expect(body.pageSize).toBe(10);
    expect(body.total).toBe(1);
    expect(body.nextCursor).toBeUndefined();

    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]?.args[0]?.input;
    expect(input?.Limit).toBe(10);
    expect(input?.ExclusiveStartKey).toBeUndefined();
    expect(input?.KeyConditionExpression).toBe('GSI1PK = :pk');
  });

  it('filters by event type when provided', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ id: '1', type: 'birthday' }],
      Count: 1,
    });

    const result = await listEvents(
      makeListEvent({ eventType: USER_EVENT_NAMES.BIRTHDAY })
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(200);

    const calls = ddbMock.commandCalls(QueryCommand);
    const input = calls[0]?.args[0]?.input;
    expect(input?.FilterExpression).toBe('#type = :type');
    expect(input?.ExpressionAttributeNames).toEqual({ '#type': 'type' });
    expect(input?.ExpressionAttributeValues?.[':type']).toBe('birthday');
  });

  it('returns 400 for invalid event type', async () => {
    const result = await listEvents(
      makeListEvent({ eventType: 'invalid-type' })
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('Invalid event type');
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('uses provided limit and cursor', async () => {
    const lastKey = { PK: 'EVENT#1', SK: 'EVENT#1' };
    const cursor = Buffer.from(JSON.stringify(lastKey)).toString('base64');

    ddbMock.on(QueryCommand).resolves({
      Items: [],
      Count: 0,
      LastEvaluatedKey: { PK: 'EVENT#2', SK: 'EVENT#2' },
    });

    const result = await listEvents(
      makeListEvent({ limit: '25', cursor })
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.pageSize).toBe(25);
    expect(body.nextCursor).toBeDefined();

    const calls = ddbMock.commandCalls(QueryCommand);
    const input = calls[0]?.args[0]?.input;
    expect(input?.Limit).toBe(25);
    expect(input?.ExclusiveStartKey).toEqual(lastKey);
  });

  it('returns 400 for invalid cursor', async () => {
    const result = await listEvents(
      makeListEvent({ cursor: 'not-base64' })
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('Invalid cursor format');
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('caps limit at 100', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });

    const result = await listEvents(
      makeListEvent({ pageSize: '1000' })
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).pageSize).toBe(100);

    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls[0]?.args[0]?.input?.Limit).toBe(100);
  });

  it('encodes nextCursor when more results exist', async () => {
    const nextKey = { PK: 'EVENT#2', SK: 'EVENT#2' };
    ddbMock.on(QueryCommand).resolves({
      Items: [],
      Count: 0,
      LastEvaluatedKey: nextKey,
    });

    const result = await listEvents(makeListEvent()) as APIGatewayProxyResult;

    const body = JSON.parse(result.body);
    expect(body.nextCursor).toBe(Buffer.from(JSON.stringify(nextKey)).toString('base64'));
  });
});
