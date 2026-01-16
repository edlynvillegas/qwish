import { SQSClient, ReceiveMessageCommand, type Message } from '@aws-sdk/client-sqs';

/**
 * Polls SQS with retries to account for eventual consistency
 */
export async function getMessageWithRetry(
  client: SQSClient, 
  queueUrl: string, 
  retries = 5
): Promise<Message[]> {
  for (let i = 0; i < retries; i++) {
    const response = await client.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 2, // Enable long polling
    }));

    if (response.Messages && response.Messages.length > 0) {
      return response.Messages;
    }

    // Wait a bit before trying again if not using max WaitTimeSeconds
    if (i < retries - 1) {
      await new Promise(res => setTimeout(res, 500));
    }
  }
  return [];
}