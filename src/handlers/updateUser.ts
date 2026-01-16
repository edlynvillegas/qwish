import type { APIGatewayProxyEvent } from 'aws-lambda';
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { updateUserPayload, updateUserEventPayload } from '../schema.ts';
import { computeNotifyUtc } from '../utils/notify.ts';
import type { User } from '../types.ts';
import { dynamoClient, USERS_TABLE } from '../lib/dynamodb.ts';
import dayjs from "../lib/dayjs";

export const updateUser = async (event: APIGatewayProxyEvent) => {
    const pathParameters = event.pathParameters;
    
    if (!pathParameters?.id) {
        return { statusCode: 400, body: JSON.stringify({ error: 'ID is required' }) };
    }

    const userId = pathParameters.id;
    const rawBody = JSON.parse(event.body ?? '{}');

    // Check if payload contains events array - if so, update events
    if (rawBody.events && Array.isArray(rawBody.events) && rawBody.events.length > 0) {
        // Validate events array structure
        const eventsToUpdate = rawBody.events;
        const updatedEvents = [];
        const errors = [];

        for (const eventUpdate of eventsToUpdate) {
            if (!eventUpdate.type) {
                errors.push(`Event type is required for all events`);
                continue;
            }

            const parsedEvent = updateUserEventPayload.safeParse(eventUpdate);
            if (!parsedEvent.success) {
                errors.push(`Invalid event data for type ${eventUpdate.type}: ${parsedEvent.error.message}`);
                continue;
            }

            const updatesRequested = parsedEvent.data;
            if (Object.keys(updatesRequested).length === 0) {
                errors.push(`At least one field must be provided for event ${eventUpdate.type}`);
                continue;
            }

            try {
                const userPK: `USER#${string}` = `USER#${userId}`;
                const eventSK: `EVENT#${string}` = `EVENT#${eventUpdate.type}`;

                // Fetch existing event
                const getEvent = await dynamoClient.send(new GetCommand({
                    TableName: USERS_TABLE,
                    Key: { PK: userPK, SK: eventSK },
                }));

                if (!getEvent.Item) {
                    errors.push(`Event ${eventUpdate.type} for user ${userId} not found`);
                    continue;
                }

                // Fetch user metadata for timezone if we need to recompute notifyUtc
                const getUser = await dynamoClient.send(new GetCommand({
                    TableName: USERS_TABLE,
                    Key: { PK: userPK, SK: 'METADATA' },
                }));

                if (!getUser.Item?.data) {
                    errors.push(`User ${userId} metadata not found`);
                    continue;
                }

                const user = getUser.Item.data as User;
                const existingEvent = getEvent.Item as any;

                const updates: string[] = [];
                const expressionAttributeValues: Record<string, any> = {};
                const expressionAttributeNames: Record<string, string> = {};

                if (updatesRequested.date !== undefined) {
                    const normalizedDate = dayjs(updatesRequested.date).format('YYYY-MM-DD');
                    updates.push('#date = :date');
                    expressionAttributeNames['#date'] = 'date';
                    expressionAttributeValues[':date'] = normalizedDate;
                    updatesRequested.date = normalizedDate;
                }

                if (updatesRequested.notifyLocalTime !== undefined) {
                    updates.push('notifyLocalTime = :notifyLocalTime');
                    expressionAttributeValues[':notifyLocalTime'] = updatesRequested.notifyLocalTime;
                }

                if (updatesRequested.label !== undefined) {
                    updates.push('#label = :label');
                    expressionAttributeNames['#label'] = 'label';
                    expressionAttributeValues[':label'] = updatesRequested.label;
                }

                // Recompute notifyUtc if date or notifyLocalTime changed
                if (updatesRequested.date !== undefined || updatesRequested.notifyLocalTime !== undefined) {
                    const date = updatesRequested.date ?? existingEvent.date;
                    const notifyLocalTime = updatesRequested.notifyLocalTime ?? existingEvent.notifyLocalTime;
                    const notifyUtc = computeNotifyUtc(date, user.timezone, notifyLocalTime);
                    updates.push('notifyUtc = :notifyUtc');
                    expressionAttributeValues[':notifyUtc'] = notifyUtc;
                }

                const result = await dynamoClient.send(new UpdateCommand({
                    TableName: USERS_TABLE,
                    Key: { PK: userPK, SK: eventSK },
                    UpdateExpression: `SET ${updates.join(', ')}`,
                    ExpressionAttributeNames: Object.keys(expressionAttributeNames).length ? expressionAttributeNames : undefined,
                    ExpressionAttributeValues: expressionAttributeValues,
                    ReturnValues: 'ALL_NEW',
                }));

                updatedEvents.push({ type: eventUpdate.type, data: result.Attributes });
            } catch (error) {
                if (error instanceof ConditionalCheckFailedException) {
                    errors.push(`Event ${eventUpdate.type} for user ${userId} not found`);
                } else {
                    errors.push(`Failed to update event ${eventUpdate.type}: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            }
        }

        // Return results - partial success is allowed
        if (errors.length > 0 && updatedEvents.length === 0) {
            return { 
                statusCode: 400, 
                body: JSON.stringify({ 
                    error: 'Failed to update events',
                    details: errors 
                }) 
            };
        }

        return { 
            statusCode: 200, 
            body: JSON.stringify({ 
                data: updatedEvents,
                errors: errors.length > 0 ? errors : undefined,
                message: `Updated ${updatedEvents.length} event(s) successfully${errors.length > 0 ? `, ${errors.length} failed` : ''}` 
            }) 
        };
    }

    // Otherwise, update user metadata
    const payload = updateUserPayload.safeParse(rawBody);
    if (!payload.success) {
        return { statusCode: 400, body: JSON.stringify({ error: payload.error }) };
    }

    if (Object.keys(payload.data || {}).length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No fields to update' }) };
    }

    try {
        // Fetch existing user metadata
        const userPK: `USER#${string}` = `USER#${pathParameters.id}`;
        const getResult = await dynamoClient.send(new GetCommand({
            TableName: USERS_TABLE,
            Key: { PK: userPK, SK: 'METADATA' },
        }));

        if (!getResult.Item) {
            return { 
                statusCode: 404, 
                body: JSON.stringify({ error: `User with id ${pathParameters.id} not found` }) 
            };
        }

        const existingUser = (getResult.Item as { data: User }).data;

        // Only include fields that are actually provided
        const updates: string[] = [];
        const expressionAttributeNames: Record<string, string> = {};
        const expressionAttributeValues: Record<string, any> = {};

        if (payload.data?.firstName !== undefined) {
            updates.push('#data.#firstName = :firstName');
            expressionAttributeNames['#data'] = 'data';
            expressionAttributeNames['#firstName'] = 'firstName';
            expressionAttributeValues[':firstName'] = payload.data.firstName;
        }
        
        if (payload.data?.lastName !== undefined) {
            updates.push('#data.#lastName = :lastName');
            expressionAttributeNames['#data'] = 'data';
            expressionAttributeNames['#lastName'] = 'lastName';
            expressionAttributeValues[':lastName'] = payload.data.lastName;
        }
        
        if (payload.data?.timezone !== undefined) {
            updates.push('#data.#tz = :timezone');
            expressionAttributeNames['#data'] = 'data';
            expressionAttributeNames['#tz'] = 'timezone';
            expressionAttributeValues[':timezone'] = payload.data.timezone;
        }
    
        if (updates.length === 0) {
            return { statusCode: 400, body: JSON.stringify({ error: 'No supported fields to update' }) };
        }

        const result = await dynamoClient.send(new UpdateCommand({
            TableName: USERS_TABLE,
            Key: { PK: userPK, SK: 'METADATA' },
            UpdateExpression: `SET ${updates.join(', ')}`,
            ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: "ALL_NEW",
        }));

        const user = (result.Attributes as { data: User } | null)?.data ?? null;
        
        return { statusCode: 200, body: JSON.stringify({ data: user, message: 'User updated successfully' }) };
    } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
            return { 
                statusCode: 404, 
                body: JSON.stringify({ error: `User with id ${pathParameters.id} not found` }) 
            };
        }
        // Re-throw other errors
        throw error;
    }
  };