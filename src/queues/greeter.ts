import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { User } from "../types";
import { getQueueUrl } from "../lib/sqs";
import { sqsClient } from "../lib/sqs";
import type { UserEventName } from "../constants/userEventNames";

const GREETER_QUEUE_NAME = process.env.GREETER_QUEUE_NAME!;

export type GreeterMessage = User & {
    pk: string;
    sk: string;
    eventType: UserEventName;
    eventDate: string;
    notifyLocalTime: string;
    lastSentYear: number;
    yearNow: number;
};

export async function enqueueGreeterMessage(
  user: User,
  event: {
    pk: string;
    sk: string;
    type: UserEventName;
    date: string;
    notifyLocalTime: string;
    lastSentYear: number;
  }
) {
    const yearNow = new Date().getFullYear();
    const queueUrl = await getQueueUrl(GREETER_QUEUE_NAME);
  
    const message: GreeterMessage = {
      ...user,
      pk: event.pk,
      sk: event.sk,
      eventType: event.type,
      eventDate: event.date,
      notifyLocalTime: event.notifyLocalTime,
      lastSentYear: event.lastSentYear ?? 0,
      yearNow,
    };

    console.log('Queue URL ->', queueUrl, JSON.stringify(message, undefined, 2));
  
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message),
        MessageGroupId: event.type,
        MessageDeduplicationId: `${user.id}-${event.type}-${yearNow}`,
      })
    );
  
    console.log('Message sent to queue');
  }