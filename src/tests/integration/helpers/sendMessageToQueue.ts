import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

/**
 * Sends a message to a specific SQS queue (useful for simulating DLQ scenarios)
 */
export async function sendMessageToQueue(
  client: SQSClient,
  queueUrl: string,
  messageBody: string,
  messageGroupId: string = 'test-group'
): Promise<void> {
  await client.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: messageBody,
    MessageGroupId: messageGroupId,
    MessageDeduplicationId: `${messageGroupId}-${Date.now()}`,
  }));
}
