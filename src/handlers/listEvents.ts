import type { APIGatewayProxyEvent } from 'aws-lambda';
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { dynamoClient, USERS_TABLE } from '../lib/dynamodb';
import { USER_EVENT_NAME_VALUES } from '../constants/userEventNames';
import { USER_INDEX_NAMES } from '../constants/userIndexNames';

export const listEvents = async (event: APIGatewayProxyEvent) => {
  const queryParams = event.queryStringParameters || {};
  const eventType = queryParams.eventType;
  const limitParam = queryParams.limit || queryParams.pageSize;
  const cursorParam = queryParams.cursor || queryParams.nextCursor || queryParams.nextToken;

  // Parse pagination limit with sane defaults and caps
  const parsedLimit = limitParam ? parseInt(limitParam, 10) : NaN;
  const pageSize = Number.isNaN(parsedLimit) || parsedLimit <= 0
    ? 10
    : Math.min(parsedLimit, 100); // cap to avoid large queries

  if (eventType && !(USER_EVENT_NAME_VALUES as readonly string[]).includes(eventType)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Invalid event type. Must be one of: ${USER_EVENT_NAME_VALUES.join(', ')}` }),
    };
  }

  let exclusiveStartKey: Record<string, any> | undefined;
  if (cursorParam) {
    try {
      const decoded = Buffer.from(cursorParam, 'base64').toString('utf-8');
      exclusiveStartKey = JSON.parse(decoded);
    } catch (err) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid cursor format' }) };
    }
  }

  const expressionAttributeValues: Record<string, any> = {
    ':pk': 'EVENT',
  };

  const params: any = {
    TableName: USERS_TABLE,
    IndexName: USER_INDEX_NAMES.ALL_EVENTS_INDEX,
    KeyConditionExpression: 'GSI1PK = :pk',
    Limit: pageSize,
    ExclusiveStartKey: exclusiveStartKey,
    ExpressionAttributeValues: expressionAttributeValues,
  };

  if (eventType) {
    params.FilterExpression = '#type = :type';
    params.ExpressionAttributeNames = { '#type': 'type' };
    params.ExpressionAttributeValues[':type'] = eventType;
  }

  const result = await dynamoClient.send(new QueryCommand(params));

  const events = result.Items || [];
  const nextCursor = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
    : undefined;

  return {
    statusCode: 200,
    body: JSON.stringify({
      data: events,
      total: result.Count || 0,
      pageSize,
      nextCursor,
    }),
  };
};
