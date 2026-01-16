import { SQSClient, ReceiveMessageCommand, GetQueueAttributesCommand, type Message } from '@aws-sdk/client-sqs';

/**
 * Waits for messages to appear in a queue by polling
 * Useful for testing DLQ scenarios where messages may take time to arrive
 */
export async function waitForQueueMessages(
  client: SQSClient,
  queueUrl: string,
  expectedCount: number = 1,
  maxAttempts: number = 15,
  waitBetweenAttempts: number = 1000,
  receiveMessages: boolean = true // Set to false to only check count without consuming
): Promise<Message[]> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // First check queue attributes to see if messages are available
    const attributes = await client.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }));

    const messageCount = parseInt(attributes.Attributes?.ApproximateNumberOfMessages || '0', 10);
    
    if (messageCount >= expectedCount) {
      if (!receiveMessages) {
        // Just confirm count without consuming messages
        console.log(`Found ${messageCount} messages in queue (not receiving)`);
        return []; // Return empty array to indicate success without consuming
      }
      
      // Try to receive the messages
      const response = await client.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
      }));

      if (response.Messages && response.Messages.length >= expectedCount) {
        return response.Messages;
      }
    }

    if (attempt < maxAttempts - 1) {
      console.log(`Waiting for ${expectedCount} messages in queue (attempt ${attempt + 1}/${maxAttempts})...`);
      await new Promise(resolve => setTimeout(resolve, waitBetweenAttempts));
    }
  }

  return [];
}
