import type { APIGatewayProxyEvent } from 'aws-lambda';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { addUserEventPayload } from '../schema';
import { computeNotifyUtc } from '../utils/notify';
import { dynamoClient, USERS_TABLE } from '../lib/dynamodb';
import type { UserEvent } from '../types';
import dayjs from "../lib/dayjs";

export const addUserEvent = async (event: APIGatewayProxyEvent) => {  
  const pathParameters = event.pathParameters;
  const userId = pathParameters?.id;

  if (!userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'User id is required' }) };
  }

  const parsed = addUserEventPayload.safeParse(JSON.parse(event.body ?? '{}'));
  if (!parsed.success) {
    return { statusCode: 400, body: JSON.stringify({ error: parsed.error }) };
  }

  const incomingEvent = parsed.data;
  const userPK: `USER#${string}` = `USER#${userId}`;
  const eventSK: `EVENT#${string}` = `EVENT#${incomingEvent.type}`;

  try {
    // Ensure user exists and get timezone
    const userResult = await dynamoClient.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { PK: userPK, SK: 'METADATA' },
    }));

    if (!userResult.Item?.data) {
      return { statusCode: 404, body: JSON.stringify({ error: `User ${userId} not found` }) };
    }

    const user = userResult.Item.data as { timezone: string; firstName: string; lastName: string; id: string };

    // Check if event already exists for this type
    const existingEvent = await dynamoClient.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { PK: userPK, SK: eventSK },
    }));

    if (existingEvent.Item) {
      return { statusCode: 409, body: JSON.stringify({ error: `Event ${incomingEvent.type} already exists for user ${user.firstName} ${user.lastName}` }) };
    }

    const normalizedDate = dayjs(incomingEvent.date).format('YYYY-MM-DD');
    const now = new Date().toISOString();
    const notifyUtc = computeNotifyUtc(normalizedDate, user.timezone, incomingEvent.notifyLocalTime, now);

    const eventItem: UserEvent = {
      type: incomingEvent.type,
      date: normalizedDate,
      notifyLocalTime: incomingEvent.notifyLocalTime,
      notifyUtc,
      createdAt: now,
      updatedAt: now,
      lastSentYear: 0,
    };

    if (incomingEvent.label) {
      eventItem.label = incomingEvent.label;
    }

    await dynamoClient.send(new PutCommand({
      TableName: USERS_TABLE,
      Item: {
        PK: userPK,
        SK: eventSK,
        GSI1PK: "EVENT",
        ...eventItem,
      },
      ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
    }));

    return { statusCode: 201, body: JSON.stringify({ data: eventItem, message: 'Event added successfully' }) };
  } catch (err: any) {
    if (err instanceof ConditionalCheckFailedException) {
      return { statusCode: 409, body: JSON.stringify({ error: `Error adding event ${incomingEvent.type} for user ${userId}` }) };
    }
    console.error('Error adding event', err);
    throw err;
  }
};
