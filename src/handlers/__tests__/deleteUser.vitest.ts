// Set environment variables before any imports
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

// Create DynamoDB mock
const ddbMock = mockClient(DynamoDBDocumentClient);
const USERS_TABLE = 'UsersTestTable';
const USER_ID = '123';
const MISSING_USER_ID = 'missing-user';

function makeDeleteEvent(id?: string): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'DELETE',
    isBase64Encoded: false,
    path: `/users/${id ?? ''}`,
    pathParameters: id ? { id } : null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
  };
}

let deleteUser: typeof import('../deleteUser').deleteUser;

describe('deleteUser', () => {
  beforeAll(async () => {
    process.env.USERS_TABLE = USERS_TABLE;
    ({ deleteUser } = await import('../deleteUser'));
  });

  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
  });

  it('returns 400 when id is missing', async () => {
    const event = makeDeleteEvent();
    const result = await deleteUser(event) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('ID is required');
  });

  it('returns 404 when user is not found', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = makeDeleteEvent(MISSING_USER_ID);
    const result = await deleteUser(event) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toBe(`User with id ${MISSING_USER_ID} not found`);
  });

  it('deletes all user metadata and events in a single batch', async () => {
    const tableName = process.env.USERS_TABLE!;
    const items = [
      { PK: `USER#${USER_ID}`, SK: 'METADATA' },
      { PK: `USER#${USER_ID}`, SK: 'EVENT#birthday' },
    ];

    ddbMock.on(QueryCommand).resolves({ Items: items });
    ddbMock.on(BatchWriteCommand).resolves({});

    const event = makeDeleteEvent(USER_ID);
    const result = await deleteUser(event) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).message).toBe('User deleted successfully');

    const calls = ddbMock.commandCalls(BatchWriteCommand);
    expect(calls).toHaveLength(1);

    const batchItems = calls[0]?.args[0]?.input?.RequestItems?.[tableName];
    expect(batchItems).toHaveLength(2);
    expect(batchItems?.[0]?.DeleteRequest?.Key).toEqual({ PK: `USER#${USER_ID}`, SK: 'METADATA' });
    expect(batchItems?.[1]?.DeleteRequest?.Key).toEqual({ PK: `USER#${USER_ID}`, SK: 'EVENT#birthday' });
  });

  it('chunks deletes the events into batches of 25', async () => {
    const tableName = process.env.USERS_TABLE!;
    const items = Array.from({ length: 30 }, (_, index) => ({
      PK: `USER#${USER_ID}`,
      SK: `EVENT#${index}`,
    }));

    ddbMock.on(QueryCommand).resolves({ Items: items });
    ddbMock.on(BatchWriteCommand).resolves({});

    const event = makeDeleteEvent(USER_ID);
    const result = await deleteUser(event) as APIGatewayProxyResult;

    expect(result.statusCode).toBe(200);

    const calls = ddbMock.commandCalls(BatchWriteCommand);
    expect(calls).toHaveLength(2);

    const firstBatchItems = calls[0]?.args[0]?.input?.RequestItems?.[tableName];
    const secondBatchItems = calls[1]?.args[0]?.input?.RequestItems?.[tableName];

    expect(firstBatchItems).toHaveLength(25);
    expect(secondBatchItems).toHaveLength(5);
  });

  it('rethrows unexpected errors', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('boom'));

    const event = makeDeleteEvent(USER_ID);

    await expect(deleteUser(event)).rejects.toThrow('boom');
  });
});
