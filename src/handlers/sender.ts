import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { GreeterMessage } from "../queues/greeter";
import dayjs from "../lib/dayjs";
import { dynamoClient, USERS_TABLE } from '../lib/dynamodb';
import type { MessageSendingStatus } from '../types';

const STUCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export const sender = async (event: any) => {
    const HOOKBIN_URL = process.env.HOOKBIN_URL!; // Read dynamically for testing
    console.log('Sender function called', event.Records.length);
    for (const record of event.Records) {
      const message = JSON.parse(record.body) as GreeterMessage;
      const { firstName, lastName, timezone, notifyLocalTime, eventDate, eventType, pk, sk, yearNow } = message;
      const fullName = `${firstName} ${lastName}`;

      try {
        console.log(`Checking if event ${pk} ${sk} already sent for year ${yearNow}`);

        // Fetch current event item
        const getEventResult = await dynamoClient.send(new GetCommand({
          TableName: USERS_TABLE,
          Key: { PK: pk, SK: sk },
        }));

        if (!getEventResult.Item) {
          console.log(`Event ${pk} ${sk} not found in database, skipping`);
          continue; // Event was deleted, skip message
        }

        const currentEvent = getEventResult.Item as any;
        const currentLastSentYear = currentEvent.lastSentYear ?? 0;
        const currentSendingStatus: MessageSendingStatus | undefined = currentEvent.sendingStatus;
        const sendingAttemptedAt: string | undefined = currentEvent.sendingAttemptedAt;
        
        // Check if already completed this year
        if (currentLastSentYear >= yearNow && currentSendingStatus === 'completed') {
          console.log(`Message already sent and completed for ${fullName} for ${eventType} in year ${yearNow}. Skipping duplicate.`);
          continue;
        }

        // Check if stuck in 'sending' state (likely previous Lambda crashed or webhook timed out)
        if (currentSendingStatus === 'sending' && sendingAttemptedAt) {
          const elapsedMs = Date.now() - new Date(sendingAttemptedAt).getTime();
          
          if (elapsedMs < STUCK_TIMEOUT_MS) {
            console.log(`Event ${pk} ${sk} is currently being processed by another Lambda (${Math.round(elapsedMs / 1000)}s elapsed). Skipping.`);
            continue; // Another Lambda is likely still processing
          }
          
          // Stuck for too long - mark as failed to allow retry (prioritizes recovery over duplicate prevention)
          // Duplicates are prevented by idempotency key in webhook call
          console.warn(`Event ${pk} ${sk} stuck in 'sending' state for ${Math.round(elapsedMs / 1000)}s. Marking as FAILED to enable retry.`);
          
          try {
            await dynamoClient.send(new UpdateCommand({
              TableName: USERS_TABLE,
              Key: { PK: pk, SK: sk },
              UpdateExpression: "SET sendingStatus = :failed, markedFailedAt = :now, failureReason = :reason, updatedAt = :now",
              ExpressionAttributeValues: {
                ":failed": "failed",
                ":now": new Date().toISOString(),
                ":reason": "Stuck in sending state - likely webhook timeout or Lambda crash"
              }
            }));
            console.log(`Marked ${pk} ${sk} as failed. Will retry on next attempt.`);
          } catch (error) {
            console.error(`Failed to mark stuck message as failed for ${pk} ${sk}:`, error);
            // Continue anyway - SQS will retry
          }
          
          // Don't continue - let it fall through to retry the message
          console.log(`Proceeding to retry message for ${pk} ${sk}`);
        }

        console.log(`Event ${pk} ${sk} lastSentYear: ${currentLastSentYear}, status: ${currentSendingStatus || 'undefined'}, proceeding to send for ${yearNow}`);

        // Calculate next year's notification time (do this before claiming to avoid wasted time)
        let nextEventDate = dayjs(eventDate).year(yearNow + 1).format('YYYY-MM-DD');
        let nextNotifyUtc = dayjs.tz(`${nextEventDate}T${notifyLocalTime}`, timezone)
                            .utc()
                            .toISOString();

        // Update DB FIRST to sendingStatus = pending
        console.log(`PHASE 1: Claiming message for ${pk} ${sk}`);
        
        try {
          await dynamoClient.send(new UpdateCommand({
            TableName: USERS_TABLE,
            Key: { PK: pk, SK: sk },
            UpdateExpression: "SET sendingStatus = :sending, sendingAttemptedAt = :now, lastSentYear = :year, notifyUtc = :notifyUtc, updatedAt = :now",
            ConditionExpression: "lastSentYear = :currentLastSentYear AND (attribute_not_exists(sendingStatus) OR sendingStatus IN (:pending, :failed))",
            ExpressionAttributeValues: {
              ":sending": "sending",
              ":now": new Date().toISOString(),
              ":year": yearNow,
              ":notifyUtc": nextNotifyUtc,
              ":currentLastSentYear": currentLastSentYear,
              ":pending": "pending",
              ":failed": "failed"
            }
          }));
          
          console.log(`Successfully claimed message for ${pk} ${sk}`);
        } catch (claimError: any) {
          if (claimError instanceof ConditionalCheckFailedException) {
            console.warn(`Failed to claim message for ${pk} ${sk}. Another process already claimed it or already sent.`);
            continue; // Another Lambda instance claimed it first
          }
          console.error("Failed to claim message for", pk, sk, "Error:", claimError.message);
          throw claimError;
        }

        // Send message to webhook
        console.log(`PHASE 2: Sending webhook for ${pk} ${sk}`);
        
        const response = await fetch(HOOKBIN_URL, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json', 
            'Idempotency-Key': `${pk}-${eventType}-${yearNow}` 
          },
          body: JSON.stringify({ message: `Hey ${fullName}, it's your ${eventType}!` }),
        });
        
        console.log("Webhook response for", fullName, ":", response.status);

        if (response.status !== 200) {
          console.error("Failed to send message to Hookbin for user", fullName);
          
          // Update status to failed
          try {
            await dynamoClient.send(new UpdateCommand({
              TableName: USERS_TABLE,
              Key: { PK: pk, SK: sk },
              UpdateExpression: "SET sendingStatus = :failed, updatedAt = :now",
              ExpressionAttributeValues: {
                ":failed": "failed",
                ":now": new Date().toISOString(),
              }
            }));
          } catch (failError) {
            console.error("Failed to update status to 'failed':", failError);
          }
          
          throw new Error(`Failed to send message to Hookbin for user ${fullName}`);
        }

        // Mark as completed with delivery proof
        console.log(`PHASE 3: Marking as completed for ${pk} ${sk}`);
        
        try {
          const result = await dynamoClient.send(new UpdateCommand({
            TableName: USERS_TABLE,
            Key: { PK: pk, SK: sk },
            UpdateExpression: "SET sendingStatus = :completed, sendingCompletedAt = :now, webhookResponseCode = :code, webhookDeliveredAt = :deliveredAt, updatedAt = :now",
            ExpressionAttributeValues: {
              ":completed": "completed",
              ":now": new Date().toISOString(),
              ":code": response.status,
              ":deliveredAt": new Date().toISOString()
            },
            ReturnValues: "ALL_NEW"
          }));
          
          const updatedEvent = result.Attributes as any | null;
          console.log("Successfully completed sending for", pk, sk, "- Status:", updatedEvent?.sendingStatus, "- Response:", response.status);
        } catch (completeError: any) {
          console.error("Failed to mark as completed for", pk, sk, "Error:", completeError.message);
          // Don't throw - message was sent successfully, just completion marking failed
          // Health check will detect this as stuck in 'sending' state and can retry
        }

      } catch (err: any) {
        if (err instanceof ConditionalCheckFailedException) {
          console.log("Duplicate message prevented for", pk, sk);
          continue;
        }
        console.error("Error processing message for event", pk, sk, ":", err);
        throw err; // causes SQS retry (and eventually DLQ after 3 attempts)
      }
    }
};
