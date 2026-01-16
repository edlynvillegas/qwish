
import { ReceiveMessageCommand, DeleteMessageCommand, SendMessageCommand, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { sqsClient, getQueueUrl, getMessageCount } from "../lib/sqs";

const DLQ_QUEUE_NAME = process.env.DLQ_QUEUE_NAME!;
const GREETER_QUEUE_NAME = process.env.GREETER_QUEUE_NAME!;

interface DLQStats {
  messagesInDLQ: number;
  messagesProcessed: number;
  messagesRedriven: number;
  messagesFailed: number;
  isServiceHealthy: boolean;
}

/**
 * Check if the Hookbin service is healthy
 */
async function checkServiceHealth(): Promise<boolean> {
  const HOOKBIN_URL = process.env.HOOKBIN_URL!; // Read dynamically for testing
  
  try {
    console.log('Checking Hookbin service health...');
    console.log('HOOKBIN_URL:', HOOKBIN_URL);
    
    // Send a test ping to Hookbin
    const response = await fetch(HOOKBIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        message: 'Health check from DLQ processor',
        timestamp: new Date().toISOString(),
        test: true
      }),
    });

    const isHealthy = response.status === 200;
    console.log(`Hookbin health check result: ${isHealthy ? 'HEALTHY' : 'UNHEALTHY'} (status: ${response.status})`);
    
    return isHealthy;
  } catch (error) {
    console.error('Hookbin health check failed:', error);
    return false;
  }
}

/**
 * Redrive messages from DLQ to main queue
 */
async function redriveMessages(maxMessages: number = 10): Promise<{ redriven: number; failed: number }> {
  let redrivenCount = 0;
  let failedCount = 0;

  console.log(`Attempting to redrive up to ${maxMessages} messages from DLQ...`);

  try {
    const dlqUrl = await getQueueUrl(DLQ_QUEUE_NAME);
    const greeterQueueUrl = await getQueueUrl(GREETER_QUEUE_NAME);

    // Receive messages from DLQ
    const receiveResult = await sqsClient.send(new ReceiveMessageCommand({
      QueueUrl: dlqUrl,
      MaxNumberOfMessages: maxMessages,
      WaitTimeSeconds: 5, // Long polling
      AttributeNames: ['All'],
      MessageAttributeNames: ['All'],
    }));

    const messages = receiveResult.Messages || [];
    console.log(`Retrieved ${messages.length} messages from DLQ`);

    for (const message of messages) {
      try {
        const messageBody = JSON.parse(message.Body || '{}');
        console.log(`Redriving message for user: ${messageBody.fullName || messageBody.id}`);

        // Send message to main queue
        await sqsClient.send(new SendMessageCommand({
          QueueUrl: greeterQueueUrl,
          MessageBody: message.Body,
          MessageGroupId: message.Attributes?.MessageGroupId || 'birthday',
          MessageDeduplicationId: message.Attributes?.MessageDeduplicationId || `redrive-${Date.now()}-${Math.random()}`,
        }));

        // Delete message from DLQ after successful redrive
        await sqsClient.send(new DeleteMessageCommand({
          QueueUrl: dlqUrl,
          ReceiptHandle: message.ReceiptHandle!,
        }));

        redrivenCount++;
        console.log(`Successfully redriven message to main queue`);
      } catch (error) {
        failedCount++;
        console.error(`Failed to redrive message:`, error);
        // Leave message in DLQ for manual intervention
      }
    }
  } catch (error) {
    console.error('Error during redrive process:', error);
  }

  return { redriven: redrivenCount, failed: failedCount };
}

/**
 * Main DLQ Processor Lambda handler
 * Runs on schedule to automatically retry failed messages
 */
export const dlqProcessor = async () => {
  console.log('DLQ Processor started');

  const stats: DLQStats = {
    messagesInDLQ: 0,
    messagesProcessed: 0,
    messagesRedriven: 0,
    messagesFailed: 0,
    isServiceHealthy: false,
  };

  try {
    // Step 1: Check how many messages are in DLQ
    stats.messagesInDLQ = await getMessageCount(DLQ_QUEUE_NAME);

    if (stats.messagesInDLQ === 0) {
      console.log('DLQ is empty, nothing to process');
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'DLQ is empty',
          stats,
        }),
      };
    }

    // Step 2: Check service health before attempting redrive
    stats.isServiceHealthy = await checkServiceHealth();

    if (!stats.isServiceHealthy) {
      console.log('Service is unhealthy, skipping redrive. Will retry on next run.');
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'Service unhealthy, redrive skipped',
          stats,
        }),
      };
    }

    console.log('Service is healthy, proceeding with redrive...');

    // Step 3: Redrive messages (process in batches of 10)
    const maxMessagesToProcess = Math.min(stats.messagesInDLQ, 10); // Process max 10 per invocation
    const { redriven, failed } = await redriveMessages(maxMessagesToProcess);

    stats.messagesRedriven = redriven;
    stats.messagesFailed = failed;
    stats.messagesProcessed = redriven + failed;

    console.log('DLQ Processor finished', stats);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'DLQ processing completed',
        stats,
      }),
    };
  } catch (error) {
    console.error('DLQ Processor failed:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'DLQ Processor failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        stats,
      }),
    };
  }
};
