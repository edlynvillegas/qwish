# QWish - Queue as you wish! ⚡

A serverless event notification system that sends "Happy Birthday" and "Happy Anniversary" messages to users at exactly 9am (or their preferred time) in their local timezone.

> **Quick Jump:** [Local Development Setup](#local-development)

## Features

✅ **Multi-Event Support** - Handles Birthdays, Anniversaries, and is extensible for other event types  
✅ **Timezone-Aware Scheduling** - Send messages at 9am local time (configurable per event) for any timezone  
✅ **AWS Serverless Architecture** - Lambda, DynamoDB (Single Table Design), SQS FIFO, EventBridge  
✅ **Dead Letter Queue** - Graceful failure handling with retry logic and automated redrive  
✅ **Duplicate Prevention** - Multi-layer idempotency checks (SQS Deduplication, Application logic, DynamoDB Conditions)  
✅ **Recovery System** - Automatically catches up on missed messages after downtime  
✅ **Health Monitoring** - Hourly checks for missed messages with automatic alerting  
✅ **REST API** - Comprehensive API for managing users and events  
✅ **TypeScript** - Type-safe code with Zod validation  
✅ **Unit Tests** - Comprehensive test coverage with Jest  

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    EventBridge Scheduler                    │
│                   (runs every 1 minute)                     │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                   Scheduler Lambda                          │
│  • Queries DynamoDB for due notifications (GSI)             │
│  • Checks: notifyUtc <= now AND lastSentYear < currentYear  │
└──────────────────────┬──────────────────────────────────────┘
                       │ enqueues messages
                       ▼
┌─────────────────────────────────────────────────────────────┐
│            GreeterQueue (SQS FIFO)                          │
│  • Content-based deduplication                              │
│  • MessageDeduplicationId: {userId}-{eventType}-{year}      │
└──────────────────────┬──────────────────────────────────────┘
                       │ triggers (batchSize: 1)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    Sender Lambda                            │
│  1. Check if lastSentYear >= currentYear (idempotency)      │
│  2. Send webhook to Hookbin                                 │
│  3. Update DynamoDB with conditional expression             │
│  4. Calculate next year's notifyUtc                         │
└──────────────────────┬──────────────────────────────────────┘
                       │
                ┌──────┴──────┐
                │             │
            ✅ Success     ❌ Failure
                │             │
                │      ┌──────┴──────┐
                │      │ Retry (3x)  │
                │      └──────┬──────┘
                │             │
                │      ┌──────┴──────────┐
                │      │  GreeterDLQ     │
                │      │ (Dead Letter Q) │
                │      └──────┬──────────┘
                │             │
                │      ┌──────▼──────────┐
                │      │ DLQ Processor   │
                │      │ (Auto-Redrive)  │
                │      └─────────────────┘
                ▼
        ┌─────────────────┐
        │   DynamoDB      │
        │ lastSentYear +=1│
        └────────┬────────┘
                 │
                 │ monitors every hour
                 ▼
        ┌─────────────────┐
        │  Health Check   │
        │  • Finds missed │
        │    messages     │
        │  • Alerts on    │
        │    issues       │
        └─────────────────┘
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/user` | Create a new user with events |
| GET | `/user` | List all users |
| PUT | `/user/{id}` | Update user details |
| DELETE | `/user/{id}` | Delete a user |
| POST | `/user/{id}/event` | Add a specific event to a user |
| GET | `/events` | List all scheduled events |

### Create User (with Events)

```bash
curl -X POST http://localhost:3000/user \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "John",
    "lastName": "Doe",
    "timezone": "America/New_York",
    "events": [
      {
        "type": "birthday",
        "date": "1990-06-15",
        "notifyLocalTime": "09:00"
      },
      {
        "type": "anniversary",
        "date": "2020-09-01",
        "label": "Work Anniversary"
      }
    ]
  }'
```

**Response:**
```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "firstName": "John",
  "lastName": "Doe",
  "timezone": "America/New_York",
  "events": [...]
}
```

### Add Event to User

```bash
curl -X POST http://localhost:3000/user/123e4567-e89b-12d3-a456-426614174000/event \
  -H "Content-Type: application/json" \
  -d '{
    "type": "anniversary",
    "date": "2015-05-20",
    "notifyLocalTime": "10:00",
    "label": "Wedding Anniversary"
  }'
```

### List Scheduled Events

```bash
# List all events
curl http://localhost:3000/events

# Filter by type with pagination
curl "http://localhost:3000/events?eventType=birthday&limit=20"
```

## Database Schema (DynamoDB Single Table Design)

The system uses a Single Table Design pattern to store both users and their events efficiently.

### Primary Keys and Indexes

| Item Type | Partition Key (PK) | Sort Key (SK) | GSI1PK (Index) | GSI1SK (Index Sort) | Description |
|-----------|-------------------|---------------|----------------|---------------------|-------------|
| **User** | `USER#{userId}` | `METADATA` | - | - | User profile (Name, Timezone) |
| **Event** | `USER#{userId}` | `EVENT#{type}` | `EVENT` | `{notifyUtc}` | Event details & scheduling info |

### Event Item Attributes
- `type`: Event type (e.g., "birthday", "anniversary")
- `date`: Date of the event (YYYY-MM-DD)
- `notifyLocalTime`: Local time to send notification (HH:mm) - Default: 09:00
- `notifyUtc`: Calculated UTC timestamp for the next notification
- `lastSentYear`: The year the last notification was successfully sent
- `label`: Optional label for the event

## How It Works

### 1. User & Event Creation
1. User provides profile + events (Birthday, Anniversary)
2. System calculates `notifyUtc` for the next occurrence of each event based on user's timezone and preferred time
3. Data is stored in DynamoDB using the single-table schema

### 2. Scheduling (Every Minute)
1. Scheduler Lambda queries the Global Secondary Index (`AllEventsIndex`)
2. Filters for: `GSI1PK="EVENT"` AND `notifyUtc <= now`
3. Checks application-level idempotency (`lastSentYear < currentYear`)
4. Enqueues due events to SQS FIFO

### 3. Message Sending
1. Sender Lambda receives event message
2. **Idempotency Check**: Verifies `lastSentYear` again to prevent duplicates
3. Sends appropriate webhook message ("Happy Birthday..." or "Happy Anniversary...")
4. **Atomic Update**: Updates `lastSentYear` and recalculates next year's `notifyUtc` in a single transaction
5. If processing fails, SQS retries automatically

### 4. Automated Recovery
A dedicated **DLQ Processor** runs every 5 minutes to monitor the Dead Letter Queue.
- Checks if the webhook service (Hookbin) is healthy
- If healthy, automatically redrives failed messages to the main queue
- Provides self-healing capabilities without manual intervention

## Duplicate Prevention Strategy

### Layer 1: SQS FIFO Deduplication
- `MessageDeduplicationId`: `${userId}-${eventType}-${year}`
- 5-minute deduplication window

### Layer 2: Pre-Send Idempotency Check
```typescript
if (event.lastSentYear >= yearNow) {
  console.log('Already sent this year, skipping');
  continue;
}
```

### Layer 3: Conditional DynamoDB Update
- Uses `ConditionExpression` to ensure `lastSentYear` hasn't changed during processing
- Prevents race conditions if multiple workers pick up the same event

## Monitoring & Observability

### Health Check Lambda
The system includes an automated health check that runs **every hour** to monitor for missed messages.

**What it checks:**
- Events scheduled in the last 24 hours that haven't been sent
- Compares `notifyUtc` (scheduled time) vs `lastSentYear` (sent status)
- Calculates hours overdue for each missed event

**Health Status Levels:**
- 🟢 **Healthy** (200): No missed events detected
- 🟡 **Warning** (207): 1-4 missed events detected
- 🔴 **Critical** (500): 5+ missed events detected

**Response Format:**
```json
{
  "status": "warning",
  "missedEventsCount": 2,
  "missedEvents": [
    {
      "userId": "USER#abc123",
      "eventType": "birthday",
      "eventDate": "1990-06-15",
      "scheduledNotifyUtc": "2026-01-16T14:00:00.000Z",
      "lastSentYear": 2025,
      "hoursOverdue": 2.3
    }
  ],
  "timestamp": "2026-01-16T16:18:00.000Z"
}
```

**Integration Points:**
- Can be connected to CloudWatch Alarms
- Can trigger SNS notifications for critical status
- Logs detailed breakdown for investigation
- Provides data for operational dashboards

**Typical Causes of Missed Messages:**
- Lambda timeout during high load
- DynamoDB throttling
- Webhook endpoint unavailable
- SQS visibility timeout issues
- Lambda crash before updating `lastSentYear`

## Local Development

### Prerequisites
- Node.js 20+
- Docker (for LocalStack)
- AWS CLI

### Webhook Setup (Required)

To test message delivery locally, you need a mock webhook URL (Hookbin) that returns a `200 OK` status.

**Recommended: Pipedream Workflow**

1. Create a new [Pipedream](https://pipedream.com) workflow.
2. Add an **HTTP / Webhook** trigger (select "Return a custom response from your workflow").
3. Add a **Node.js** step and use the following code:

```javascript
export default defineComponent({
  name: "Process Webhook Message",
  description: "Process a message from a webhook trigger",
  type: "action",
  props: {
    message: {
      type: "string",
      label: "Message",
      description: "Message from webhook body",
      optional: false
    }
  },
  async run({ $ }) {
    // 1. Log for debugging in Pipedream console
    console.log("📩 Received QWish Notification:", body.message);
    console.log("🔑 Idempotency Key:", headers['idempotency-key']);

    // 2. Handle missing data
    if (!this.message) {
      return await $.respond({
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { 
          error: "Validation Failed",
          message: "The 'message' field is required and cannot be empty." 
        }
      })
    }

    const responseBody = {
      success: true,
      message: this.message 
    }
    // 3. Send 200 OK back to QWish (CRITICAL)
    // If this is missing or returns non-200, QWish will retry/fail.
    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: responseBody
    })

    // Return data for use in later Pipedream steps (optional)
    return responseBody
  },
})
```

4. Deploy and copy the endpoint URL.
5. Use this URL for the `HOOKBIN_URL` environment variable.

### Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start LocalStack:**
   ```bash
   docker-compose up -d
   ```

3. **Set environment variables:**
   ```bash
   export HOOKBIN_URL=https://hookb.in/YOUR_ENDPOINT
   ```

4. **Deploy serverless offline locally:**
   ```bash
   npm run deploy:local
   ```

5. **Start serverless offline:**
   ```bash
   npm run start:local
   ```
   The API will be available at `http://localhost:3000`

### Testing

```bash
# Runs all tests (unit + integration)
npm run test:all

# Run unit tests
npm run test:unit

# Run integration tests
npm run test:integration
```

### Integration Test Scenarios

The integration tests verify critical edge cases and recovery scenarios:

1. **Happy Path**: Creates user, schedules message, sends webhook, verifies delivery
2. **Duplicate Prevention**: Verifies idempotency - retrying completed messages doesn't resend
3. **Webhook Downtime Recovery**: 
   - Simulates webhook service failure (503 errors)
   - Message fails and goes to DLQ after retries
   - Webhook recovers
   - DLQ processor redrives messages
   - Verifies successful delivery with no duplicates
4. **Stuck Message Detection**: 
   - Simulates Lambda crash during message sending
   - Event stuck in `'sending'` state beyond timeout
   - Sender detects stuck state, marks as failed, and retries
   - Verifies successful recovery with delivery proof

These tests ensure the system meets critical requirements:
- **Recovery**: All unsent messages eventually send, even after extended downtime
- **No Duplicates**: Idempotency keys and conditional updates prevent duplicate sends
- **Scalability**: Tests batch processing and concurrent scenarios

## Project Structure

```
qwish/
├── src/
│   ├── handlers/           # Lambda function handlers
│   │   ├── addUserEvent.ts # POST /user/{id}/event
│   │   ├── createUser.ts   # POST /user
│   │   ├── deleteUser.ts   # DELETE /user/{id}
│   │   ├── dlqProcessor.ts # Automated DLQ recovery
│   │   ├── healthCheck.ts  # Hourly monitoring for missed messages
│   │   ├── listEvents.ts   # GET /events
│   │   ├── listUser.ts     # GET /user
│   │   ├── scheduler.ts    # EventBridge cron
│   │   ├── sender.ts       # SQS consumer
│   │   └── updateUser.ts   # PUT /user/{id}
│   ├── queues/
│   │   └── greeter.ts      # SQS Producer logic
│   ├── utils/
│   │   ├── notify.ts       # notifyUtc calculation logic
│   │   └── ...
│   ├── constants/          # Event names & Index constants
│   ├── schema.ts           # Zod validation schemas
│   ├── lib/               # AWS SDK clients (Dynamo, SQS)
│   └── types.ts           # TypeScript type definitions
├── serverless.yml         # Infrastructure as Code
├── docker-compose.yml     # LocalStack setup
├── DLQ-GUIDE.md           # DLQ troubleshooting guide
└── README.md              # This file
```

## Technologies Used

- **Runtime**: Node.js 20, TypeScript
- **Cloud**: AWS Lambda, DynamoDB, SQS, EventBridge, CloudWatch
- **Framework**: Serverless Framework v4
- **Validation**: Zod
- **Testing**: Vitest
- **Local Dev**: LocalStack, Serverless Offline
- **Date/Time**: dayjs (with timezone plugin)

## License

ISC

## Author

Edlyn Villegas