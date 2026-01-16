import { GetCommand, QueryCommand, type QueryCommandOutput } from "@aws-sdk/lib-dynamodb";  
import dayjs from "../lib/dayjs";
import { enqueueGreeterMessage } from '../queues/greeter';
import type { User } from '../types';
import { dynamoClient, USERS_TABLE } from '../lib/dynamodb';
import { USER_INDEX_NAMES } from '../constants/userIndexNames';

export const scheduler = async () => {
    console.log('Scheduler started');

    const nowUtc = dayjs.utc().toISOString();
    const currentYear = new Date().getFullYear();
    
    let totalUsersProcessed = 0;
    let totalEnqueueFailures = 0;
    let totalPages = 0;

    const ALL_EVENTS_PK = "EVENT";
    let lastEvaluatedKey: Record<string, any> | undefined;
    let pageNumber = 0;

    do {
        let result: QueryCommandOutput;
        try {
            pageNumber++;
            totalPages++;
            console.log(`Processing page ${pageNumber} (all event types)...`, {
                nowUtc,
                currentYear,
                lastEvaluatedKey,
            });

            // Query all events due now across all types
            result = await dynamoClient.send(new QueryCommand({
                TableName: USERS_TABLE,
                IndexName: USER_INDEX_NAMES.ALL_EVENTS_INDEX,
                KeyConditionExpression: 'GSI1PK = :pk AND notifyUtc <= :now',
                FilterExpression: 'attribute_not_exists(lastSentYear) OR lastSentYear < :year',
                ExpressionAttributeValues: {
                    ':pk': ALL_EVENTS_PK,
                    ':now': nowUtc,
                    ':year': currentYear
                },
                Limit: 100,
                ExclusiveStartKey: lastEvaluatedKey,
            }));
        } catch (err) {
            console.error(`Error processing page ${pageNumber}:`, err);
            // Stop and retry on next scheduler run
            throw err;
        }

        try {
            const events = result.Items || [];
            let pageEnqueued = 0;
            let pageEnqueueFailed = 0;

            console.log(`Found ${events.length} events to notify on page ${pageNumber}`);
            
            for (const eventItem of events) {
                try {
                    // Fetch user metadata for names/timezone
                    const metadataResult = await dynamoClient.send(new GetCommand({
                        TableName: USERS_TABLE,
                        Key: { PK: eventItem.PK, SK: 'METADATA' },
                    }));

                    if (!metadataResult.Item?.data) {
                        console.warn(`Metadata missing for ${eventItem.PK}, skipping`);
                        continue;
                    }

                    const userData = metadataResult.Item.data as User;

                    await enqueueGreeterMessage(
                        userData,
                        {
                            pk: eventItem.PK,
                            sk: eventItem.SK,
                            type: eventItem.type,
                            date: eventItem.date,
                            notifyLocalTime: eventItem.notifyLocalTime,
                            lastSentYear: eventItem.lastSentYear ?? 0,
                        }
                    );
                    console.log(`Enqueued greeter message for ${userData.firstName} (${userData.id}) [${eventItem.type}]`);
                    totalUsersProcessed++;
                    pageEnqueued++;
                } catch (err) {
                    pageEnqueueFailed++;
                    totalEnqueueFailures++;
                    console.error(`Failed to enqueue message for ${eventItem?.PK ?? 'unknown' }:`, err);
                }
            }

            console.log(`Page ${pageNumber} summary (all types)`, {
                pageEnqueued,
                pageEnqueueFailed,
                cumulativeEnqueued: totalUsersProcessed,
                cumulativeFailures: totalEnqueueFailures,
            });
        } catch (error) {
            // Processing failed after we already have LastEvaluatedKey
            console.warn('Failed processing this page, skipping it:', {
                pageNumber,
                lastEvaluatedKeyExists: Boolean(result.LastEvaluatedKey),
                error,
            });
            // Decide to skip: drop this page’s items and move on
            lastEvaluatedKey = result.LastEvaluatedKey;
            continue; // loop to next page
        }
    
        // Get the key to continue pagination
        lastEvaluatedKey = result.LastEvaluatedKey;

        if (lastEvaluatedKey) {
            console.log(`More events available, continuing to page ${pageNumber + 1}...`);
        }
    } while (lastEvaluatedKey);

    console.log(`Scheduler finished. Total users processed: ${totalUsersProcessed} across ${totalPages} pages`);
    return { 
        statusCode: 200, 
        body: JSON.stringify({ 
            message: 'Scheduler finished',
            totalUsers: totalUsersProcessed,
            totalPages,
            enqueueFailures: totalEnqueueFailures,
        })
    };
};
