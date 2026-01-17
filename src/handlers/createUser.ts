import type { APIGatewayProxyEvent } from 'aws-lambda';
import { BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from 'uuid';
import { createUserPayload } from '../schema.ts';
import { type User, type UserEvent } from '../types.ts';
import { flattenUserToDynamoDBItems } from '../utils/flattenUserToDynamoDBItems.ts';
import { computeNotifyUtc } from '../utils/notify.ts';
import { dynamoClient, USERS_TABLE } from '../lib/dynamodb.ts';
import dayjs from "../lib/dayjs";

const DEFAULT_NOTIFY_LOCAL_TIME = '09:00';

export const createUser = async (event: APIGatewayProxyEvent) => {
	const payload = createUserPayload.safeParse(JSON.parse(event.body!));
	if (!payload.success) {
		console.error('Error creating user ->', payload.error);
		return { statusCode: 400, body: JSON.stringify({ error: payload.error }) }; 
	}
	
	const id = uuidv4();
	const now = new Date().toISOString();

	const baseUser: User = {
		id,
		firstName: payload.data.firstName,  
		lastName: payload.data.lastName,
		timezone: payload.data.timezone,
		createdAt: now,
		updatedAt: now,
	};

	const events: UserEvent[] = payload.data.events.map((event) => {
		const normalizedDate = dayjs(event.date).format('YYYY-MM-DD');
		const notifyLocalTime = event.notifyLocalTime || DEFAULT_NOTIFY_LOCAL_TIME;
		const notifyUtc = computeNotifyUtc(normalizedDate, payload.data.timezone, notifyLocalTime, now);

		const newEvent: UserEvent = {
			type: event.type,
			date: normalizedDate,
			notifyLocalTime,
			notifyUtc,
			createdAt: now,
			updatedAt: now,
			lastSentYear: 0
		};

		if (event.label !== undefined) {
			newEvent.label = event.label;
		}

		return newEvent;
	});

	const dynamoItems = flattenUserToDynamoDBItems({
		...baseUser,
		events,
	});

	const chunkSize = 25; // DynamoDB BatchWrite limit
	for (let i = 0; i < dynamoItems.length; i += chunkSize) {
		const chunk = dynamoItems.slice(i, i + chunkSize);
		await dynamoClient.send(new BatchWriteCommand({
			RequestItems: {
				[USERS_TABLE]: chunk.map((Item) => ({
					PutRequest: { Item },
				})),
			},
		}));
	}

	return { statusCode: 201, body: JSON.stringify({ ...baseUser, events }) };
};