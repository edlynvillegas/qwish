import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import dayjs from "../lib/dayjs";
import { dynamoClient, USERS_TABLE } from '../lib/dynamodb';
import { USER_INDEX_NAMES } from '../constants/userIndexNames';
import type { MessageSendingStatus } from '../types';

const STUCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for health check (longer than sender's 5 min)

interface MissedEvent {
  userId: string;
  eventType: string;
  eventDate: string;
  scheduledNotifyUtc: string;
  lastSentYear: number;
  hoursOverdue: number;
  sendingStatus?: string;
}

interface StuckEvent {
  userId: string;
  eventType: string;
  eventDate: string;
  sendingStatus: string;
  sendingAttemptedAt: string;
  minutesStuck: number;
  action: 'monitoring' | 'marked_failed_for_retry';
}

interface HealthCheckResult {
  status: 'healthy' | 'warning' | 'critical';
  missedEventsCount: number;
  stuckEventsCount: number;
  missedEvents: MissedEvent[];
  stuckEvents: StuckEvent[];
  timestamp: string;
}

export const healthCheck = async (): Promise<{ statusCode: number; body: string }> => {
  console.log('Health check started');

  const currentYear = new Date().getFullYear();
  const now = dayjs.utc();
  const oneDayAgo = now.subtract(24, 'hours').toISOString();
  const nowIso = now.toISOString();
  const nowMs = now.valueOf();

  try {
    // === CHECK 1: Query for missed events (should have been sent but weren't) ===
    console.log('CHECK 1: Querying for potentially missed events', {
      timeWindow: `${oneDayAgo} to ${nowIso}`,
      expectedYear: currentYear
    });

    const missedResult = await dynamoClient.send(new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: USER_INDEX_NAMES.ALL_EVENTS_INDEX,
      KeyConditionExpression: 'GSI1PK = :pk AND notifyUtc BETWEEN :oneDayAgo AND :now',
      FilterExpression: '(attribute_not_exists(lastSentYear) OR lastSentYear < :year) AND (attribute_not_exists(sendingStatus) OR sendingStatus <> :completed)',
      ExpressionAttributeValues: {
        ':pk': 'EVENT',
        ':oneDayAgo': oneDayAgo,
        ':now': nowIso,
        ':year': currentYear,
        ':completed': 'completed'
      }
    }));

    const missedEvents: MissedEvent[] = (missedResult.Items || []).map(event => {
      const scheduledTime = dayjs(event.notifyUtc);
      const hoursOverdue = now.diff(scheduledTime, 'hours', true);
      
      return {
        userId: event.PK as string,
        eventType: event.type as string,
        eventDate: event.date as string,
        scheduledNotifyUtc: event.notifyUtc as string,
        lastSentYear: (event.lastSentYear as number) ?? 0,
        sendingStatus: event.sendingStatus as string | undefined,
        hoursOverdue: Math.round(hoursOverdue * 10) / 10
      };
    });

    // === CHECK 2: Query for stuck 'sending' events ===
    console.log('CHECK 2: Querying for stuck events in "sending" state');

    const stuckResult = await dynamoClient.send(new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: USER_INDEX_NAMES.ALL_EVENTS_INDEX,
      KeyConditionExpression: 'GSI1PK = :pk',
      FilterExpression: 'sendingStatus = :sending AND attribute_exists(sendingAttemptedAt)',
      ExpressionAttributeValues: {
        ':pk': 'EVENT',
        ':sending': 'sending'
      }
    }));

    const stuckEvents: StuckEvent[] = [];
    
    for (const event of stuckResult.Items || []) {
      const attemptedAt = event.sendingAttemptedAt as string;
      const elapsedMs = nowMs - new Date(attemptedAt).getTime();
      const minutesStuck = Math.round(elapsedMs / 60000);

      if (elapsedMs > STUCK_TIMEOUT_MS) {
        // Stuck for too long - mark as failed to allow retry (prioritizes recovery over duplicate prevention)
        console.warn(`Marking stuck event ${event.PK} ${event.SK} as FAILED for retry (stuck for ${minutesStuck} minutes)`);
        
        try {
          await dynamoClient.send(new UpdateCommand({
            TableName: USERS_TABLE,
            Key: { PK: event.PK, SK: event.SK },
            UpdateExpression: "SET sendingStatus = :failed, markedFailedAt = :now, failureReason = :reason, updatedAt = :now",
            ExpressionAttributeValues: {
              ":failed": "failed",
              ":now": nowIso,
              ":reason": "Stuck in sending state detected by health check - likely webhook timeout or Lambda crash"
            }
          }));

          stuckEvents.push({
            userId: event.PK as string,
            eventType: event.type as string,
            eventDate: event.date as string,
            sendingStatus: 'sending',
            sendingAttemptedAt: attemptedAt,
            minutesStuck,
            action: 'marked_failed_for_retry'
          });
        } catch (error) {
          console.error(`Failed to mark stuck event as failed ${event.PK} ${event.SK}:`, error);
          
          stuckEvents.push({
            userId: event.PK as string,
            eventType: event.type as string,
            eventDate: event.date as string,
            sendingStatus: 'sending',
            sendingAttemptedAt: attemptedAt,
            minutesStuck,
            action: 'monitoring'
          });
        }
      } else {
        // Still within timeout - just monitoring
        stuckEvents.push({
          userId: event.PK as string,
          eventType: event.type as string,
          eventDate: event.date as string,
          sendingStatus: 'sending',
          sendingAttemptedAt: attemptedAt,
          minutesStuck,
          action: 'monitoring'
        });
      }
    }

    // === Determine overall health status ===
    const missedCount = missedEvents.length;
    const stuckCount = stuckEvents.length;
    const totalIssues = missedCount + stuckCount;

    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    if (totalIssues > 0 && totalIssues < 5) {
      status = 'warning';
    } else if (totalIssues >= 5) {
      status = 'critical';
    }

    const healthResult: HealthCheckResult = {
      status,
      missedEventsCount: missedCount,
      stuckEventsCount: stuckCount,
      missedEvents,
      stuckEvents,
      timestamp: nowIso
    };

    // === Logging ===
    if (status === 'healthy') {
      console.log('Health check passed: No issues detected');
    } else if (status === 'warning') {
      console.warn(`Health check WARNING: ${totalIssues} issues detected (${missedCount} missed, ${stuckCount} stuck)`, {
        missedEvents,
        stuckEvents
      });
    } else {
      console.error(`Health check CRITICAL: ${totalIssues} issues detected (${missedCount} missed, ${stuckCount} stuck)`, {
        missedEvents,
        stuckEvents
      });
    }

    if (missedCount > 0) {
      console.log('Missed events breakdown:');
      missedEvents.forEach((event, index) => {
        console.log(`  ${index + 1}. User: ${event.userId}, Type: ${event.eventType}, ` +
          `Scheduled: ${event.scheduledNotifyUtc}, Hours overdue: ${event.hoursOverdue}, ` +
          `Status: ${event.sendingStatus || 'undefined'}`);
      });
    }

    if (stuckCount > 0) {
      console.log('Stuck events breakdown:');
      stuckEvents.forEach((event, index) => {
        console.log(`  ${index + 1}. User: ${event.userId}, Type: ${event.eventType}, ` +
          `Stuck for: ${event.minutesStuck} minutes, Action: ${event.action}`);
      });
    }

    return {
      statusCode: status === 'healthy' ? 200 : status === 'warning' ? 207 : 500,
      body: JSON.stringify(healthResult, null, 2)
    };

  } catch (error: any) {
    console.error('Health check failed with error:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: 'error',
        message: 'Health check execution failed',
        error: error.message,
        timestamp: nowIso
      }, null, 2)
    };
  }
};
