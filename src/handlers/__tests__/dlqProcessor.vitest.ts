import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SQSClient,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';

const sqsMock = mockClient(SQSClient);
const mockFetch = vi.fn();
const AWS_ENDPOINT_URL = 'http://localhost:8000';
const AWS_REGION = 'us-east-1';
const DLQ_QUEUE_NAME = 'GreeterDLQ.fifo';
const GREETER_QUEUE_NAME = 'GreeterQueue.fifo';
const DLQ_URL = 'https://sqs.test/dlq';
const GREETER_QUEUE_URL = 'https://sqs.test/greeter';
const HOOKBIN_URL = 'https://hookbin.test';

let dlqProcessor: typeof import('../dlqProcessor').dlqProcessor;

describe('dlqProcessor', () => {
  beforeAll(async () => {
    process.env.AWS_ENDPOINT_URL = AWS_ENDPOINT_URL;
    process.env.AWS_REGION = AWS_REGION;
    process.env.DLQ_QUEUE_NAME = DLQ_QUEUE_NAME;
    process.env.GREETER_QUEUE_NAME = GREETER_QUEUE_NAME;
    process.env.DLQ_URL = DLQ_URL;
    process.env.GREETER_QUEUE_URL = GREETER_QUEUE_URL;
    process.env.HOOKBIN_URL = HOOKBIN_URL;
    globalThis.fetch = mockFetch as any;
    ({ dlqProcessor } = await import('../dlqProcessor'));
  });

  beforeEach(() => {
    sqsMock.reset();
    vi.clearAllMocks();
    
    // Mock GetQueueUrlCommand for all tests
    sqsMock.on(GetQueueUrlCommand).callsFake((input) => {
      if (input.QueueName === DLQ_QUEUE_NAME) {
        return { QueueUrl: DLQ_URL };
      }
      if (input.QueueName === GREETER_QUEUE_NAME) {
        return { QueueUrl: GREETER_QUEUE_URL };
      }
      throw new Error(`Unknown queue: ${input.QueueName}`);
    });
  });

  it('returns early when DLQ is empty', async () => {
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '0' },
    });

    const result = await dlqProcessor();

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.message).toBe('DLQ is empty');
    expect(body.stats.messagesInDLQ).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(sqsMock.commandCalls(ReceiveMessageCommand)).toHaveLength(0);
  });

  it('skips redrive when service is unhealthy', async () => {
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '2' },
    });
    mockFetch.mockResolvedValue({ status: 500 });

    const result = await dlqProcessor();

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.message).toBe('Service unhealthy, redrive skipped');
    expect(body.stats.isServiceHealthy).toBe(false);
    expect(sqsMock.commandCalls(ReceiveMessageCommand)).toHaveLength(0);
  });

  it('redrives messages when service is healthy', async () => {
    sqsMock.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '2' },
    });
    mockFetch.mockResolvedValue({ status: 200 });
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [
        {
          Body: JSON.stringify({ id: '1', fullName: 'Ada Lovelace' }),
          ReceiptHandle: 'rh-1',
          Attributes: { MessageGroupId: 'birthday', MessageDeduplicationId: 'dedupe-1' },
        },
        {
          Body: JSON.stringify({ id: '2', fullName: 'Grace Hopper' }),
          ReceiptHandle: 'rh-2',
          Attributes: { MessageGroupId: 'anniversary', MessageDeduplicationId: 'dedupe-2' },
        },
      ],
    });
    sqsMock.on(SendMessageCommand).resolves({});
    sqsMock.on(DeleteMessageCommand).resolves({});

    const result = await dlqProcessor();

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.message).toBe('DLQ processing completed');
    expect(body.stats.messagesProcessed).toBe(2);
    expect(body.stats.messagesRedriven).toBe(2);
    expect(body.stats.messagesFailed).toBe(0);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(2);
    expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(2);
  });
});
