# AWS Bedrock Batch Inference Queue Library

A TypeScript library for queuing and processing LLM tasks via AWS Bedrock batch inference jobs. This library provides automatic batching, job status tracking in PostgreSQL, and event-driven notifications with result retrieval capabilities.

## Features

- **Automatic Batching**: Queues tasks and automatically flushes when thresholds are reached
- **Job Tracking**: Tracks job status in PostgreSQL database with automatic status updates
- **Event-Driven**: Emits events for job status changes, completions, and errors
- **Result Retrieval**: Easy retrieval of batch inference results from S3
- **Polling Support**: Automatic polling with manual override options
- **Multi-Model Support**: Configurable for any AWS Bedrock model (Claude, Titan, etc.)

## Installation

```bash
npm install aws-bedrock-batch-inference-queue
```

## Prerequisites

1. **PostgreSQL Database**: Set up a PostgreSQL database and run the schema migration (see `database/schema.sql`)
2. **AWS Credentials**: Configure AWS credentials with permissions for:
   - AWS Bedrock (CreateModelInvocationJob, GetModelInvocationJob)
   - S3 (PutObject, GetObject, ListObjects)
3. **IAM Role**: Create an IAM role for Bedrock batch inference jobs with appropriate permissions
4. **S3 Buckets**: Create S3 buckets for input and output files

## Database Setup

Run the schema migration to create the required tables and types:

```sql
-- See database/schema.sql for the complete schema
psql -U your_user -d your_database -f database/schema.sql
```

## Configuration

### Basic Configuration

```typescript
import { BedrockQueue } from 'aws-bedrock-batch-inference-queue';

const queue = new BedrockQueue({
  // AWS Configuration
  accessKeyId: 'your-access-key-id',
  secretAccessKey: 'your-secret-access-key',
  region: 'us-east-1',
  roleArn: 'arn:aws:iam::123456789012:role/BedrockBatchInferenceRole',

  // S3 Configuration
  s3InputBucket: 'my-bedrock-input-bucket',
  s3InputPrefix: 'bedrock-jobs/input/',
  s3OutputBucket: 'my-bedrock-output-bucket',
  s3OutputPrefix: 'bedrock-jobs/output/',

  // Database Configuration
  dbHost: 'localhost',
  dbPort: 5432,
  dbName: 'bedrock_jobs',
  dbUser: 'postgres',
  dbPassword: 'your-password',

  // Model Configuration
  modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  jobType: 'retrieval-summary',

  // Optional: Batching Configuration
  batchSize: 1000, // Default: 1000 (AWS minimum)
  maxBatchSize: 50000, // Default: 50000 (AWS maximum)
  maxFileSizeBytes: 1024 * 1024 * 1024, // Default: 1GB
  maxJobSizeBytes: 5 * 1024 * 1024 * 1024, // Default: 5GB

  // Optional: Polling Configuration
  pollIntervalMs: 30000, // Default: 30 seconds
  enableAutoPolling: true, // Default: true
});

// Initialize the queue (test database connection)
await queue.initialize();
```

## Usage

### Basic Usage

```typescript
import { BedrockQueue, BedrockTask } from 'aws-bedrock-batch-inference-queue';

// Create queue instance
const queue = new BedrockQueue(config);
await queue.initialize();

// Queue tasks
const task: BedrockTask = {
  recordId: 'task-1',
  modelInput: {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Summarize this document...',
          },
        ],
      },
    ],
  },
};

await queue.enqueue(task);

// Queue will automatically flush when threshold is reached
// Or manually flush
const jobId = await queue.flush();

// Wait for job completion
const result = await queue.awaitJob(jobId);
console.log('Job completed:', result.status);
console.log('Results:', result.results);
```

### Example: Claude Sonnet 4.5

```typescript
const queue = new BedrockQueue({
  // ... configuration
  modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  jobType: 'retrieval-summary',
});

await queue.initialize();

// Queue multiple tasks
for (let i = 0; i < 1500; i++) {
  await queue.enqueue({
    recordId: `task-${i}`,
    modelInput: {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Process document ${i}`,
            },
          ],
        },
      ],
    },
  });
}

// Queue will automatically flush at 1000 tasks
// Get the job ID from the event or manually flush remaining tasks
const remainingJobId = await queue.flush();

// Wait for all jobs to complete
const results = await queue.awaitJobs([jobId, remainingJobId]);
```

### Example: Amazon Titan Embed

```typescript
const queue = new BedrockQueue({
  // ... configuration
  modelId: 'amazon.titan-embed-text-v2:0',
  jobType: 'text-embed',
});

await queue.initialize();

// Queue embedding tasks
await queue.enqueue({
  recordId: 'embed-1',
  modelInput: {
    inputText: 'This is the text to embed',
  },
});

const jobId = await queue.flush();
const result = await queue.awaitJob(jobId);

// Access embeddings
result.results?.forEach((taskResult) => {
  if (taskResult.modelOutput) {
    console.log('Embedding:', taskResult.modelOutput.embedding);
  }
});
```

### Event Handling

```typescript
// Listen to events
queue.on('task-queued', (task) => {
  console.log('Task queued:', task.recordId);
});

queue.on('batch-flushed', (jobId, recordCount) => {
  console.log(`Batch flushed: ${jobId} with ${recordCount} records`);
});

queue.on('job-queued', (jobId, jobArn) => {
  console.log(`Job queued: ${jobId} (ARN: ${jobArn})`);
});

queue.on('job-status-changed', (jobId, status) => {
  console.log(`Job ${jobId} status: ${status}`);
});

queue.on('job-completed', (jobId, result) => {
  console.log(`Job ${jobId} completed:`, result);
  console.log('Results:', result.results);
});

queue.on('job-failed', (jobId, error) => {
  console.error(`Job ${jobId} failed:`, error);
});

queue.on('error', (error) => {
  console.error('Queue error:', error);
});
```

### Manual Status Checks

```typescript
// Get job status
const status = await queue.getJobStatus(jobId);
console.log('Job status:', status);

// Get job results
if (status === 'completed') {
  const results = await queue.getJobResults(jobId);
  console.log('Results:', results);
}
```

### Multiple Jobs (Promise.all equivalent)

```typescript
// Queue multiple batches
const jobIds: string[] = [];
for (let i = 0; i < 5; i++) {
  // ... queue tasks
  const jobId = await queue.flush();
  jobIds.push(jobId);
}

// Wait for all jobs to complete
const results = await queue.awaitJobs(jobIds);
results.forEach((result) => {
  console.log(`Job ${result.jobId}: ${result.status}`);
});
```

### Cleanup

```typescript
// Close connections when done
await queue.close();
```

## API Reference

### BedrockQueue

#### Constructor

```typescript
new BedrockQueue(config: BedrockQueueConfig)
```

#### Methods

##### `initialize(): Promise<void>`

Initialize the queue and test database connection.

##### `enqueue(task: BedrockTask): Promise<void>`

Add a task to the queue. Automatically flushes if threshold is reached.

##### `flush(): Promise<string>`

Manually flush the queue and create a batch inference job. Returns the job UUID.

##### `getQueueSize(): number`

Get the current number of tasks in the queue.

##### `getJobStatus(jobId: string): Promise<JobStatus>`

Get the current status of a job.

##### `getJobResults(jobId: string): Promise<TaskResult[]>`

Retrieve results from S3 for a completed job.

##### `awaitJob(jobId: string): Promise<JobResult>`

Wait for a job to complete and return the result.

##### `awaitJobs(jobIds: string[]): Promise<JobResult[]>`

Wait for multiple jobs to complete (Promise.all equivalent).

##### `close(): Promise<void>`

Close database connections and cleanup.

#### Events

- `task-queued`: Emitted when a task is added to the queue
- `batch-flushed`: Emitted when the queue is flushed (jobId, recordCount)
- `job-queued`: Emitted when a job is submitted to AWS (jobId, jobArn)
- `job-status-changed`: Emitted when job status changes (jobId, status)
- `job-completed`: Emitted when job completes (jobId, result)
- `job-failed`: Emitted when job fails (jobId, error)
- `error`: Emitted when an error occurs (error)

## Types

### BedrockQueueConfig

```typescript
interface BedrockQueueConfig {
  // AWS Configuration
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  roleArn: string;

  // S3 Configuration
  s3InputBucket: string;
  s3InputPrefix: string;
  s3OutputBucket: string;
  s3OutputPrefix: string;

  // Database Configuration
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;

  // Model Configuration
  modelId: string;
  jobType: 'retrieval-summary' | 'text-embed';

  // Optional: Batching Configuration
  batchSize?: number;
  maxBatchSize?: number;
  maxFileSizeBytes?: number;
  maxJobSizeBytes?: number;

  // Optional: Polling Configuration
  pollIntervalMs?: number;
  enableAutoPolling?: boolean;
}
```

### BedrockTask

```typescript
interface BedrockTask {
  recordId: string;
  modelInput: Record<string, any>; // Model-specific input format
}
```

### JobResult

```typescript
interface JobResult {
  jobId: string;
  status: JobStatus;
  jobArn?: string;
  s3InputUri?: string;
  s3OutputUri?: string;
  errorMessage?: string;
  results?: TaskResult[];
  recordCount?: number;
}
```

### TaskResult

```typescript
interface TaskResult {
  recordId: string;
  modelOutput?: any;
  error?: {
    code: string;
    message: string;
  };
}
```

## AWS Bedrock Constraints

- **Minimum records per job**: 1,000
- **Maximum records per job**: 50,000
- **Maximum file size**: 1 GB
- **Maximum job size**: 5 GB
- **Maximum concurrent jobs**: 10 per account per model ID

The library automatically enforces these constraints.

## Model Input Formats

### Claude Models

```typescript
{
  recordId: 'task-1',
  modelInput: {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Your prompt here',
          },
        ],
      },
    ],
  },
}
```

### Titan Embed Models

```typescript
{
  recordId: 'task-1',
  modelInput: {
    inputText: 'Text to embed',
  },
}
```

## Error Handling

The library emits error events for various failure scenarios:

- Database connection errors
- S3 upload/download errors
- AWS Bedrock API errors
- Job execution errors

Listen to the `error` event to handle errors:

```typescript
queue.on('error', (error) => {
  console.error('Error:', error);
  // Handle error appropriately
});
```

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

