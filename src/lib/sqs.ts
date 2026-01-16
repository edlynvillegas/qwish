import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";

export const sqsClient = new SQSClient({
  endpoint: process.env.AWS_ENDPOINT_URL!,
  region: process.env.AWS_REGION!,
});

const cachedQueueUrls = new Map<string, string>();

export async function getQueueUrl(queueName: string): Promise<string> {
    const cached = cachedQueueUrls.get(queueName);
    if (cached) return cached;
    try {
        const { QueueUrl } = await sqsClient.send(new GetQueueUrlCommand({
            QueueName: queueName,
        }));
        const resolvedUrl = QueueUrl!;
        cachedQueueUrls.set(queueName, resolvedUrl);
        return resolvedUrl;
    } catch (error) {
        console.error('Error getting queue URL:', error);
        throw error;
    }
}

/**
* Get the number of messages in the queue
*/
export async function getMessageCount(queueName: string): Promise<number> {
 try {
   const queueUrl = await getQueueUrl(queueName);
   console.log('Getting message count...', { queueName, queueUrl });
   const result = await sqsClient.send(new GetQueueAttributesCommand({
     QueueUrl: queueUrl,
     AttributeNames: ['ApproximateNumberOfMessages'],
   }));

   const count = parseInt(result.Attributes?.ApproximateNumberOfMessages || '0');
   console.log(`Queue ${queueName} contains approximately ${count} messages`);
   return count;
 } catch (error) {
   console.error(`Failed to get message count for queue ${queueName}:`, error);
   return 0;
 }
}