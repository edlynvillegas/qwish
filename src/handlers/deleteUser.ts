import type { APIGatewayProxyEvent } from 'aws-lambda';
import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { dynamoClient, USERS_TABLE } from '../lib/dynamodb.ts';

export const deleteUser = async (event: APIGatewayProxyEvent) => {
    const pathParameters = event.pathParameters;

    if (!pathParameters?.id) {
        return { statusCode: 400, body: JSON.stringify({ error: 'ID is required' }) };
    }
  
    try {
        const userPK: `USER#${string}` = `USER#${pathParameters.id}`;

        // Fetch all items for the user (metadata + events)
        const queryResult = await dynamoClient.send(new QueryCommand({
            TableName: USERS_TABLE,
            KeyConditionExpression: 'PK = :pk',
            ExpressionAttributeValues: {
                ':pk': userPK,
            },
        }));

        const items = queryResult.Items || [];

        if (items.length === 0) {
            throw new ConditionalCheckFailedException({
                $metadata: {},
                message: `User with id ${pathParameters.id} not found`,
            });
        }

        // DynamoDB BatchWrite supports 25 items max per request
        const chunkSize = 25;
        for (let i = 0; i < items.length; i += chunkSize) {
            const chunk = items.slice(i, i + chunkSize);
            await dynamoClient.send(new BatchWriteCommand({
                RequestItems: {
                    [USERS_TABLE]: chunk.map((item) => ({
                        DeleteRequest: {
                            Key: {
                                PK: item.PK,
                                SK: item.SK,
                            },
                        },
                    })),
                },
            }));
        }

        return { statusCode: 200, body: JSON.stringify({ message: 'User deleted successfully' }) };
    } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
            return { statusCode: 404, body: JSON.stringify({ error: `User with id ${pathParameters.id} not found` }) };
        }
        // Re-throw other errors
        throw error;
    }
  };