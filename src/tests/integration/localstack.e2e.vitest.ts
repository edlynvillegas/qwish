import http from 'http';
import dayjs from '../../lib/dayjs';
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { buildTestUserPayload } from './helpers/buildTestUserPayload';
import { getMessageWithRetry } from './helpers/getMessageWithRetry';
import { sendMessageToQueue } from './helpers/sendMessageToQueue';
import { waitForQueueMessages } from './helpers/waitForQueueMessages';
import { createControllableWebhookServer } from './helpers/createControllableWebhookServer';

const RUN_INTEGRATION_TESTS = process.env.RUN_INTEGRATION_TESTS === 'true';
const describeIf = RUN_INTEGRATION_TESTS ? describe : describe.skip;

const LOCALSTACK_ENDPOINT = process.env.AWS_ENDPOINT_URL || 'http://localhost:4566';
const REGION = process.env.AWS_REGION || 'ap-southeast-1';
const getUsersTable = () => process.env.USERS_TABLE || 'UsersIntegrationTest';
const getGreeterQueueName = () => process.env.GREETER_QUEUE_NAME || 'GreeterQueueIntegration.fifo';
const getDlqQueueName = () => process.env.DLQ_QUEUE_NAME || 'GreeterDLQIntegration.fifo';

describeIf('LocalStack E2E', () => {
  let dynamoClient: DynamoDBClient;
  let docClient: DynamoDBDocumentClient;
  let sqsClient: SQSClient;
  let server: http.Server;
  let hookbinUrl: string;
  let receivedMessages: string[] = [];
  let testUserIds: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        receivedMessages.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });

    const address = server.address();
    if (typeof address === 'object' && address?.port) {
      hookbinUrl = `http://127.0.0.1:${address.port}`;
    } else {
      throw new Error('Failed to start local webhook server');
    }

    process.env.HOOKBIN_URL = hookbinUrl;

    console.log('Integration test env', {
      awsEndpointUrl: process.env.AWS_ENDPOINT_URL,
      awsRegion: process.env.AWS_REGION,
      usersTable: getUsersTable(),
      greeterQueueName: getGreeterQueueName(),
      dlqQueueName: getDlqQueueName(),
      hookbinUrl: process.env.HOOKBIN_URL,
    });

    dynamoClient = new DynamoDBClient({ endpoint: LOCALSTACK_ENDPOINT, region: REGION });
    docClient = DynamoDBDocumentClient.from(dynamoClient);
    sqsClient = new SQSClient({ endpoint: LOCALSTACK_ENDPOINT, region: REGION });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    console.log('Integration test webhook server stopped');
  });

  beforeEach(async () => {
    receivedMessages = [];
    
    // Purge main queue
    const { QueueUrl: mainQueueUrl } = await sqsClient.send(new GetQueueUrlCommand({ QueueName: getGreeterQueueName() }));
    if (mainQueueUrl) await sqsClient.send(new PurgeQueueCommand({ QueueUrl: mainQueueUrl }));

    // Purge DLQ
    const { QueueUrl: dlqUrl } = await sqsClient.send(new GetQueueUrlCommand({ QueueName: getDlqQueueName() }));
    if (dlqUrl) await sqsClient.send(new PurgeQueueCommand({ QueueUrl: dlqUrl }));

    if (testUserIds.length > 0) {
      const deleteRequests = testUserIds.map(id => ({
        DeleteRequest: { Key: { PK: `USER#${id}`, SK: 'EVENT#birthday' } }
      }));

      await docClient.send(new BatchWriteCommand({
        RequestItems: { [getUsersTable()]: deleteRequests },
      }));
      
      testUserIds = []; // Reset for the next test
    }
  });

  it('should create a user, schedule a message, enqueue a message, send a webhook', async () => {
    // Single source of truth for year calculations
    const currentYear = new Date().getFullYear();
    
    const { createUser } = await import('../../handlers/createUser');
    const { scheduler } = await import('../../handlers/scheduler');
    const { sender } = await import('../../handlers/sender');

    const {
      firstName,
      lastName,
      timezone,
      eventDate,
      notifyLocalTime,
      createEvent,
    } = buildTestUserPayload(20260115);

    console.log('Integration test data', {
      firstName,
      lastName,
      timezone,
      eventDate,
      notifyLocalTime,
    });

    const createResult = await createUser(createEvent as any);
    expect(createResult.statusCode).toBe(201);
    const created = JSON.parse(createResult.body);
    const userId = created.id as string;
    testUserIds.push(userId);

    const pk = `USER#${userId}`;
    const sk = 'EVENT#birthday';

    const dueNotifyUtc = dayjs.utc().subtract(1, 'minute').toISOString();
    await docClient.send(new UpdateCommand({
      TableName: getUsersTable(),
      Key: { PK: pk, SK: sk },
      UpdateExpression: 'SET notifyUtc = :notifyUtc, lastSentYear = :lastSentYear',
      ExpressionAttributeValues: {
        ':notifyUtc': dueNotifyUtc,
        ':lastSentYear': 0,
      },
    }));

    await scheduler();

    const { QueueUrl } = await sqsClient.send(new GetQueueUrlCommand({ QueueName: getGreeterQueueName() }));
    expect(QueueUrl).toBeTruthy();

    const messages = await getMessageWithRetry(sqsClient, QueueUrl!, 3);
    expect(messages.length).toBe(1);

    const senderEvent = {
      Records: messages.map((message) => ({ body: message.Body })),
    };

    await sender(senderEvent as any);

    const webhookPayload = JSON.parse(receivedMessages[0] ?? '{}');
    expect(webhookPayload.message).toContain(`Hey ${firstName} ${lastName}`);

    const updatedEvent = await docClient.send(new GetCommand({
      TableName: getUsersTable(),
      Key: { PK: pk, SK: sk },
    }));

    expect(updatedEvent.Item?.lastSentYear).toBe(currentYear);

    const receiptHandle = messages?.[0]?.ReceiptHandle;
    if (QueueUrl && receiptHandle) {
      await sqsClient.send(new DeleteMessageCommand({
        QueueUrl,
        ReceiptHandle: receiptHandle,
      }));
    }
  });

  it('should prevent duplicate send when lastSentYear already updated', async () => {
    // Single source of truth for year calculations
    const currentYear = new Date().getFullYear();
    
    const { createUser } = await import('../../handlers/createUser');
    const { scheduler } = await import('../../handlers/scheduler');
    const { sender } = await import('../../handlers/sender');

    const {
      firstName,
      lastName,
      timezone,
      eventDate,
      notifyLocalTime,
      createEvent,
    } = buildTestUserPayload(20260116);

    console.log('Integration test data', {
      firstName,
      lastName,
      timezone,
      eventDate,
      notifyLocalTime,
    });

    const createResult = await createUser(createEvent as any);
    expect(createResult.statusCode).toBe(201);
    const created = JSON.parse(createResult.body);
    const userId = created.id as string;
    testUserIds.push(userId);

    const pk = `USER#${userId}`;
    const sk = 'EVENT#birthday';

    const dueNotifyUtc = dayjs.utc().subtract(1, 'minute').toISOString();
    await docClient.send(new UpdateCommand({
      TableName: getUsersTable(),
      Key: { PK: pk, SK: sk },
      UpdateExpression: 'SET notifyUtc = :notifyUtc, lastSentYear = :lastSentYear',
      ExpressionAttributeValues: {
        ':notifyUtc': dueNotifyUtc,
        ':lastSentYear': 0,
      },
    }));

    await scheduler();

    const { QueueUrl } = await sqsClient.send(new GetQueueUrlCommand({ QueueName: getGreeterQueueName() }));
    expect(QueueUrl).toBeTruthy();
    
    const messages = await getMessageWithRetry(sqsClient, QueueUrl!, 3);
    expect(messages.length).toBe(1);

    const senderEvent = {
      Records: messages.map((message) => ({ body: message.Body })),
    };

    await sender(senderEvent as any);
    const firstSendCount = receivedMessages.length;
    expect(firstSendCount).toBe(1);

    await sender(senderEvent as any);
    expect(receivedMessages.length).toBe(firstSendCount);

    const updatedEvent = await docClient.send(new GetCommand({
      TableName: getUsersTable(),
      Key: { PK: pk, SK: sk },
    }));

    expect(updatedEvent.Item?.lastSentYear).toBe(currentYear);

    const receiptHandle = messages?.[0]?.ReceiptHandle;
    if (QueueUrl && receiptHandle) {
      await sqsClient.send(new DeleteMessageCommand({
        QueueUrl,
        ReceiptHandle: receiptHandle,
      }));
    }
  });

  it('should recover from webhook downtime via DLQ processing and prevent duplicates', { timeout: 20000 }, async () => {
    // Single source of truth for year calculations
    const currentYear = new Date().getFullYear();
    
    // Create controllable webhook server FIRST before importing handlers
    const webhookControl = await createControllableWebhookServer();
    const originalHookbinUrl = process.env.HOOKBIN_URL;
    process.env.HOOKBIN_URL = webhookControl.url;
    
    // Now import handlers (they will read the correct HOOKBIN_URL)
    const { createUser } = await import('../../handlers/createUser');
    const { scheduler } = await import('../../handlers/scheduler');
    const { sender } = await import('../../handlers/sender');
    const { dlqProcessor } = await import('../../handlers/dlqProcessor');

    try {
      const {
        firstName,
        lastName,
        timezone,
        eventDate,
        notifyLocalTime,
        createEvent,
      } = buildTestUserPayload(20260118);

      console.log('=== RECOVERY TEST: Setup ===');
      console.log('Test user:', { firstName, lastName });

      // Create user
      const createResult = await createUser(createEvent as any);
      expect(createResult.statusCode).toBe(201);
      const created = JSON.parse(createResult.body);
      const userId = created.id as string;
      testUserIds.push(userId);

      const pk = `USER#${userId}`;
      const sk = 'EVENT#birthday';

      // Set event as due
      const dueNotifyUtc = dayjs.utc().subtract(1, 'minute').toISOString();
      await docClient.send(new UpdateCommand({
        TableName: getUsersTable(),
        Key: { PK: pk, SK: sk },
        UpdateExpression: 'SET notifyUtc = :notifyUtc, lastSentYear = :lastSentYear, sendingStatus = :pending',
        ExpressionAttributeValues: {
          ':notifyUtc': dueNotifyUtc,
          ':lastSentYear': 0,
          ':pending': 'pending',
        },
      }));

      // === PHASE 1: WEBHOOK DOWN - SIMULATE FAILURE ===
      console.log('=== PHASE 1: Webhook DOWN ===');
      webhookControl.setShouldFail(true);

      // Schedule the message
      await scheduler();

      const { QueueUrl: mainQueueUrl } = await sqsClient.send(
        new GetQueueUrlCommand({ QueueName: getGreeterQueueName() })
      );
      const { QueueUrl: dlqUrl } = await sqsClient.send(
        new GetQueueUrlCommand({ QueueName: getDlqQueueName() })
      );

      // Get message from main queue
      const messages = await getMessageWithRetry(sqsClient, mainQueueUrl!, 5);
      expect(messages.length).toBe(1);
      console.log('Message received from main queue');

      const senderEvent = {
        Records: messages.map((message) => ({ body: message.Body })),
      };

      // Try to send - should fail with 503
      let firstAttemptFailed = false;
      try {
        await sender(senderEvent as any);
      } catch (error: any) {
        firstAttemptFailed = true;
        console.log('First attempt failed as expected:', error.message);
      }

      expect(firstAttemptFailed).toBe(true);

      // Verify event status is 'failed' after webhook failure
      const eventAfterFirstFailure = await docClient.send(new GetCommand({
        TableName: getUsersTable(),
        Key: { PK: pk, SK: sk },
      }));

      console.log('Event status after first failure:', eventAfterFirstFailure.Item?.sendingStatus);
      expect(eventAfterFirstFailure.Item?.sendingStatus).toBe('failed');
      expect(eventAfterFirstFailure.Item?.lastSentYear).toBe(currentYear); // Year was updated in PHASE 1 (claim)
      expect(webhookControl.receivedMessages.length).toBe(0); // No successful sends yet

      // Simulate SQS retries (in real AWS, SQS would retry automatically)
      // After 2 more retries (total 3), message goes to DLQ
      console.log('Simulating SQS retries...');
      for (let retry = 1; retry <= 2; retry++) {
        try {
          await sender(senderEvent as any);
        } catch (error) {
          console.log(`Retry ${retry} failed (expected)`);
        }
      }

      // Manually send to DLQ (simulating SQS automatic DLQ routing after max retries)
      console.log('Sending message to DLQ (simulating SQS exhausted retries)');
      console.log('DLQ URL:', dlqUrl);
      console.log('DLQ Queue Name:', getDlqQueueName());
      if (!dlqUrl) {
        throw new Error('DLQ URL is undefined');
      }
      if (messages.length === 0 || messages[0]?.Body === undefined || typeof messages[0].Body !== "string") {
        throw new Error('Message body is undefined');
      }
      await sendMessageToQueue(sqsClient, dlqUrl, messages[0].Body, 'birthday-dlq-group');
      console.log('Message sent to DLQ successfully');

      // Wait for message to appear in DLQ (check count only, don't consume)
      console.log('Waiting for message to appear in DLQ...');
      await waitForQueueMessages(sqsClient, dlqUrl, 1, 10, 500, false); // false = don't consume messages
      console.log('Message confirmed in DLQ (via queue attributes)');

      // Verify still no successful webhook calls
      expect(webhookControl.receivedMessages.length).toBe(0);

      // === PHASE 2: WEBHOOK RECOVERS ===
      console.log('=== PHASE 2: Webhook RECOVERS ===');
      webhookControl.setShouldFail(false);
      console.log('Webhook server should fail:', webhookControl.getShouldFail());
      console.log('Current HOOKBIN_URL:', process.env.HOOKBIN_URL);
      console.log('Webhook control URL:', webhookControl.url);

      // Wait for LocalStack eventual consistency (DLQ message count to update)
      console.log('Waiting for LocalStack DLQ consistency...');
      await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay

      // Run DLQ processor to redrive messages
      console.log('Running DLQ processor...');
      const dlqResult = await dlqProcessor();
      const dlqBody = JSON.parse(dlqResult.body);

      console.log('DLQ processor result:', {
        isServiceHealthy: dlqBody.stats.isServiceHealthy,
        messagesRedriven: dlqBody.stats.messagesRedriven,
        dlqDepth: dlqBody.stats.dlqDepth,
      });

      expect(dlqBody.stats.isServiceHealthy).toBe(true);
      expect(dlqBody.stats.messagesRedriven).toBeGreaterThan(0);

      // Clear webhook messages from health check (health check sends a POST too)
      console.log('Clearing health check messages, count:', webhookControl.receivedMessages.length);
      webhookControl.clearMessages();

      // Wait for redriven message to appear in main queue
      console.log('Waiting for redriven message in main queue...');
      const redrivenMessages = await waitForQueueMessages(sqsClient, mainQueueUrl!, 1, 10, 500);
      expect(redrivenMessages.length).toBeGreaterThan(0);
      console.log('Redriven message received from main queue');

      const retryEvent = {
        Records: redrivenMessages.map((message) => ({ body: message.Body })),
      };

      // Process redriven message - should succeed now
      console.log('Processing redriven message...');
      await sender(retryEvent as any);

      // === PHASE 3: VERIFICATION ===
      console.log('=== PHASE 3: Verification ===');

      // Check webhook received exactly ONE message (no duplicates)
      expect(webhookControl.receivedMessages.length).toBe(1);
      if (webhookControl.receivedMessages.length === 0 || typeof webhookControl.receivedMessages[0] !== "string") {
        throw new Error('Webhook message is missing');
      }
      const webhookPayload = JSON.parse(webhookControl.receivedMessages[0]);
      expect(webhookPayload.message).toContain(`Hey ${firstName} ${lastName}`);
      console.log('Webhook received message:', webhookPayload.message);

      // Check event marked as completed with delivery proof
      const finalEvent = await docClient.send(new GetCommand({
        TableName: getUsersTable(),
        Key: { PK: pk, SK: sk },
      }));

      console.log('Final event status:', {
        sendingStatus: finalEvent.Item?.sendingStatus,
        lastSentYear: finalEvent.Item?.lastSentYear,
        webhookResponseCode: finalEvent.Item?.webhookResponseCode,
        sendingCompletedAt: finalEvent.Item?.sendingCompletedAt,
      });

      expect(finalEvent.Item?.sendingStatus).toBe('completed');
      expect(finalEvent.Item?.lastSentYear).toBe(currentYear);
      expect(finalEvent.Item?.webhookResponseCode).toBe(200);
      expect(finalEvent.Item?.webhookDeliveredAt).toBeTruthy();
      expect(finalEvent.Item?.sendingCompletedAt).toBeTruthy();

      // === PHASE 4: TEST DUPLICATE PREVENTION ===
      console.log('=== PHASE 4: Duplicate Prevention ===');

      // Try to process the message again - should be skipped
      webhookControl.clearMessages();
      await sender(retryEvent as any);

      // Should still be only the one message from before (no new webhook call)
      expect(webhookControl.receivedMessages.length).toBe(0);
      console.log('Duplicate prevention verified - message skipped on retry');

      // Clean up messages from queues
      if (redrivenMessages[0]?.ReceiptHandle) {
        await sqsClient.send(new DeleteMessageCommand({
          QueueUrl: mainQueueUrl!,
          ReceiptHandle: redrivenMessages[0].ReceiptHandle,
        }));
      }

      console.log('=== RECOVERY TEST: Complete ===');
    } finally {
      // Restore original webhook URL and close test server
      process.env.HOOKBIN_URL = originalHookbinUrl;
      await webhookControl.close();
    }
  });

  it('should detect and retry stuck messages (simulating Lambda crash)', { timeout: 15000 }, async () => {
    // Single source of truth for year calculations
    const currentYear = new Date().getFullYear();
    const lastYear = currentYear - 1;
    
    const { createUser } = await import('../../handlers/createUser');
    const { scheduler } = await import('../../handlers/scheduler');
    const { sender } = await import('../../handlers/sender');

    const {
      firstName,
      lastName,
      timezone,
      eventDate,
      notifyLocalTime,
      createEvent,
    } = buildTestUserPayload(20260119);

    console.log('=== STUCK MESSAGE TEST: Setup ===');
    console.log('Test user:', { firstName, lastName });

    // Create user
    const createResult = await createUser(createEvent as any);
    expect(createResult.statusCode).toBe(201);
    const created = JSON.parse(createResult.body);
    const userId = created.id as string;
    testUserIds.push(userId);

    const pk = `USER#${userId}`;
    const sk = 'EVENT#birthday';

    // Set event as due
    const dueNotifyUtc = dayjs.utc().subtract(1, 'minute').toISOString();
    await docClient.send(new UpdateCommand({
      TableName: getUsersTable(),
      Key: { PK: pk, SK: sk },
      UpdateExpression: 'SET notifyUtc = :notifyUtc, lastSentYear = :lastSentYear',
      ExpressionAttributeValues: {
        ':notifyUtc': dueNotifyUtc,
        ':lastSentYear': 0,
      },
    }));

    // === PHASE 1: SIMULATE STUCK STATE (Lambda crash during sending) ===
    console.log('=== PHASE 1: Simulating stuck state ===');

    // Manually set the event to 'sending' state with old timestamp (simulating Lambda crash)
    const stuckTimestamp = dayjs.utc().subtract(6, 'minutes').toISOString(); // 6 minutes ago (exceeds 5 min timeout)
    await docClient.send(new UpdateCommand({
      TableName: getUsersTable(),
      Key: { PK: pk, SK: sk },
      UpdateExpression: 'SET sendingStatus = :sending, sendingAttemptedAt = :stuckTime, lastSentYear = :year',
      ExpressionAttributeValues: {
        ':sending': 'sending',
        ':stuckTime': stuckTimestamp,
        ':year': lastYear, // Last year - so scheduler will pick it up
      },
    }));

    // Verify stuck state
    const stuckEvent = await docClient.send(new GetCommand({
      TableName: getUsersTable(),
      Key: { PK: pk, SK: sk },
    }));

    console.log('Event stuck state:', {
      sendingStatus: stuckEvent.Item?.sendingStatus,
      sendingAttemptedAt: stuckEvent.Item?.sendingAttemptedAt,
      minutesAgo: Math.round((Date.now() - new Date(stuckEvent.Item?.sendingAttemptedAt).getTime()) / 60000),
    });

    expect(stuckEvent.Item?.sendingStatus).toBe('sending');

    // === PHASE 2: TRIGGER SENDER WITH STUCK MESSAGE ===
    console.log('=== PHASE 2: Processing stuck message ===');

    // Schedule to create a message in the queue
    await scheduler();

    const { QueueUrl: mainQueueUrl } = await sqsClient.send(
      new GetQueueUrlCommand({ QueueName: getGreeterQueueName() })
    );

    const messages = await getMessageWithRetry(sqsClient, mainQueueUrl!, 5);
    expect(messages.length).toBe(1);

    const senderEvent = {
      Records: messages.map((message) => ({ body: message.Body })),
    };

    // Process - should detect stuck state, mark as failed, then retry
    await sender(senderEvent as any);

    // === PHASE 3: VERIFICATION ===
    console.log('=== PHASE 3: Verification ===');

    const finalEvent = await docClient.send(new GetCommand({
      TableName: getUsersTable(),
      Key: { PK: pk, SK: sk },
    }));

    console.log('Final event status:', {
      sendingStatus: finalEvent.Item?.sendingStatus,
      markedFailedAt: finalEvent.Item?.markedFailedAt,
      failureReason: finalEvent.Item?.failureReason,
      webhookResponseCode: finalEvent.Item?.webhookResponseCode,
    });

    // Should have been marked as failed and then retried successfully
    expect(finalEvent.Item?.sendingStatus).toBe('completed');
    expect(finalEvent.Item?.markedFailedAt).toBeTruthy(); // Evidence it was marked failed
    expect(finalEvent.Item?.failureReason).toContain('Stuck in sending state');
    expect(finalEvent.Item?.webhookResponseCode).toBe(200); // Successfully sent after retry
    expect(finalEvent.Item?.lastSentYear).toBe(currentYear);

    // Verify webhook was actually called
    expect(receivedMessages.length).toBe(1);
    if (receivedMessages.length === 0 || typeof receivedMessages[0] !== "string") {
      throw new Error('Received messages is missing');
    }
    const webhookPayload = JSON.parse(receivedMessages[0]);
    expect(webhookPayload.message).toContain(`Hey ${firstName} ${lastName}`);

    console.log('=== STUCK MESSAGE TEST: Complete ===');
    console.log('Message was successfully recovered and sent after detecting stuck state');

    // Clean up
    if (messages[0]?.ReceiptHandle) {
      await sqsClient.send(new DeleteMessageCommand({
        QueueUrl: mainQueueUrl!,
        ReceiptHandle: messages[0].ReceiptHandle,
      }));
    }
  });
});
