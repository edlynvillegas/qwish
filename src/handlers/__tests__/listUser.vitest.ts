import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

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
    path: '/users',
    pathParameters: null,
    queryStringParameters,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
  };
}

let listUser: typeof import('../listUser').listUser;

describe('listUser', () => {
  beforeAll(async () => {
    process.env.USERS_TABLE = USERS_TABLE;
    ({ listUser } = await import('../listUser'));
  });

  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
  });

  it('returns users with default page size', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [{ id: '1', firstName: 'Ada' }],
      Count: 1,
    });

    const result = await listUser(makeListEvent()) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data).toEqual([{ id: '1', firstName: 'Ada' }]);
    expect(body.pageSize).toBe(10);
    expect(body.total).toBe(1);
    expect(body.nextCursor).toBeUndefined();

    const calls = ddbMock.commandCalls(ScanCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]?.input?.Limit).toBe(10);
    expect(calls[0]?.args[0]?.input?.ExclusiveStartKey).toBeUndefined();
  });

  it('uses provided limit and cursor', async () => {
    const lastKey = { PK: 'USER#1', SK: 'METADATA' };
    const cursor = Buffer.from(JSON.stringify(lastKey)).toString('base64');

    ddbMock.on(ScanCommand).resolves({
      Items: [],
      Count: 0,
      LastEvaluatedKey: { PK: 'USER#2', SK: 'METADATA' },
    });

    const result = await listUser(
      makeListEvent({ limit: '25', cursor })
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.pageSize).toBe(25);
    expect(body.nextCursor).toBeDefined();

    const calls = ddbMock.commandCalls(ScanCommand);
    expect(calls[0]?.args[0]?.input?.Limit).toBe(25);
    expect(calls[0]?.args[0]?.input?.ExclusiveStartKey).toEqual(lastKey);
  });

  it('returns 400 for invalid cursor', async () => {
    const result = await listUser(
      makeListEvent({ cursor: 'not-base64' })
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('Invalid cursor format');
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  it('caps limit at 100', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [], Count: 0 });

    const result = await listUser(
      makeListEvent({ pageSize: '1000' })
    ) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).pageSize).toBe(100);

    const calls = ddbMock.commandCalls(ScanCommand);
    expect(calls[0]?.args[0]?.input?.Limit).toBe(100);
  });

  it('encodes nextCursor when more results exist', async () => {
    const nextKey = { PK: 'USER#2', SK: 'METADATA' };
    ddbMock.on(ScanCommand).resolves({
      Items: [],
      Count: 0,
      LastEvaluatedKey: nextKey,
    });

    const result = await listUser(makeListEvent()) as APIGatewayProxyResult;

    const body = JSON.parse(result.body);
    expect(body.nextCursor).toBe(Buffer.from(JSON.stringify(nextKey)).toString('base64'));
  });
});
