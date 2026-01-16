import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { CreateQueueCommand, DeleteQueueCommand, SQSClient } from '@aws-sdk/client-sqs';

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS === 'true';
const LOCALSTACK_ENDPOINT = process.env.AWS_ENDPOINT_URL || 'http://localhost:4566';
const REGION = process.env.AWS_REGION || 'ap-southeast-1';

export default async function globalSetup() {
  if (!RUN_INTEGRATION_TESTS) {
    return () => {}; // No-op teardown
  }

  // 1. Capture existing env state to decide if we should cleanup later
  const hadUsersTable = Boolean(process.env.USERS_TABLE);
  const hadGreeterQueueName = Boolean(process.env.GREETER_QUEUE_NAME);
  const hadDlqQueueName = Boolean(process.env.DLQ_QUEUE_NAME);

  // 2. Setup unique Run ID and Environment
  const runId = process.env.INTEGRATION_RUN_ID || `${Date.now()}`;
  process.env.INTEGRATION_RUN_ID = runId;
  process.env.AWS_ENDPOINT_URL = LOCALSTACK_ENDPOINT;
  process.env.AWS_REGION = REGION;
  process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test';
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test';

  // Define names using the RUN_ID for isolation
  const usersTableName = process.env.USERS_TABLE || `UsersIntegrationTest-${runId}`;
  const greeterQueueName = process.env.GREETER_QUEUE_NAME || `GreeterQueueIntegration-${runId}.fifo`;
  const dlqQueueName = process.env.DLQ_QUEUE_NAME || `GreeterDLQIntegration-${runId}.fifo`;

  // Export back to process.env so the tests can see them
  process.env.USERS_TABLE = usersTableName;
  process.env.GREETER_QUEUE_NAME = greeterQueueName;
  process.env.DLQ_QUEUE_NAME = dlqQueueName;

  const dynamoClient = new DynamoDBClient({ endpoint: LOCALSTACK_ENDPOINT, region: REGION });
  const sqsClient = new SQSClient({ endpoint: LOCALSTACK_ENDPOINT, region: REGION });

  console.log('🚀 Global Setup: Provisioning resources for Run ID:', runId);

  // 3. Provision DynamoDB
  let createdTable = false;
  try {
    await dynamoClient.send(new DescribeTableCommand({ TableName: usersTableName }));
    console.log('ℹ️ Table already exists:', usersTableName);
  } catch {
    await dynamoClient.send(new CreateTableCommand({
      TableName: usersTableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'type', AttributeType: 'S' },
        { AttributeName: 'notifyUtc', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'TypeIndex',
          KeySchema: [
            { AttributeName: 'type', KeyType: 'HASH' },
            { AttributeName: 'notifyUtc', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'AllEventsIndex',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'notifyUtc', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }));
    createdTable = true;
    await waitUntilTableExists({ client: dynamoClient, minDelay: 1, maxWaitTime: 30 }, { TableName: usersTableName });
    console.log('✅ Table created:', usersTableName);
  }

  // 4. Provision SQS Queues
  const queueAttributes = {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'true',
  };

  const [dlqResult, greeterResult] = await Promise.all([
    sqsClient.send(new CreateQueueCommand({ QueueName: dlqQueueName, Attributes: queueAttributes })),
    sqsClient.send(new CreateQueueCommand({ QueueName: greeterQueueName, Attributes: queueAttributes }))
  ]);

  const dlqQueueUrl = dlqResult.QueueUrl;
  const greeterQueueUrl = greeterResult.QueueUrl;

  console.log('✅ Queues ready:', { greeterQueueUrl, dlqQueueUrl });

  // 5. THE TEARDOWN FUNCTION
  // This is returned to Vitest and called once after all tests are done.
  return async () => {
    console.log('🧹 Global Teardown: Starting cleanup...');

    const cleanupTasks: Promise<any>[] = [];

    if (greeterQueueUrl && !hadGreeterQueueName) {
      cleanupTasks.push(sqsClient.send(new DeleteQueueCommand({ QueueUrl: greeterQueueUrl }))
        .then(() => console.log('🗑️ Deleted Queue:', greeterQueueName)));
    }

    if (dlqQueueUrl && !hadDlqQueueName) {
      cleanupTasks.push(sqsClient.send(new DeleteQueueCommand({ QueueUrl: dlqQueueUrl }))
        .then(() => console.log('🗑️ Deleted Queue:', dlqQueueName)));
    }

    if (createdTable && !hadUsersTable) {
      cleanupTasks.push(dynamoClient.send(new DeleteTableCommand({ TableName: usersTableName }))
        .then(() => console.log('🗑️ Deleted Table:', usersTableName)));
    }

    await Promise.allSettled(cleanupTasks);
    console.log('✨ Cleanup complete.');
  };
}