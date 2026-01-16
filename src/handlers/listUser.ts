import type { APIGatewayProxyEvent } from 'aws-lambda';
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { dynamoClient, USERS_TABLE } from '../lib/dynamodb.ts';

export const listUser = async (event: APIGatewayProxyEvent) => {
  console.log('AWS endpoint ->', process.env.AWS_ENDPOINT_URL!, 'AWS region ->', process.env.AWS_REGION!);

  // Get query parameters
  const queryParams = event.queryStringParameters || {};
  const limitParam = queryParams.limit || queryParams.pageSize;
  const cursorParam = queryParams.cursor || queryParams.nextCursor || queryParams.nextToken;

  // Parse pagination limit with sane defaults and caps
  const parsedLimit = limitParam ? parseInt(limitParam, 10) : NaN;
  const pageSize = Number.isNaN(parsedLimit) || parsedLimit <= 0
    ? 10
    : Math.min(parsedLimit, 100); // cap to avoid large scans

  let exclusiveStartKey: Record<string, any> | undefined;
  if (cursorParam) {
    try {
      const decoded = Buffer.from(cursorParam, 'base64').toString('utf-8');
      exclusiveStartKey = JSON.parse(decoded);
    } catch (err) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid cursor format' }),
      };
    }
  }

  const result = await dynamoClient.send(
    new ScanCommand({
      TableName: USERS_TABLE,
      FilterExpression: "SK = :metadata",
      ExpressionAttributeValues: {
        ":metadata": "METADATA",
      },
      Limit: pageSize,
      ExclusiveStartKey: exclusiveStartKey,
    })
  );

  const users = result.Items || [];

  // Encode next cursor if more items are available
  const nextCursor = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
    : undefined;

  return {
    statusCode: 200,
    body: JSON.stringify({
      data: users,
      total: result.Count || 0,
      pageSize,
      nextCursor,
    }),
  };
};