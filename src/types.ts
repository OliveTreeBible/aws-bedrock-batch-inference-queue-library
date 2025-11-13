/**
 * Configuration interface for BedrockQueue
 */
export interface BedrockQueueConfig {
  // AWS Configuration
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  roleArn: string;

  // S3 Configuration
  s3InputBucket: string;
  s3InputPrefix: string; // e.g., "bedrock-jobs/input/"
  s3OutputBucket: string;
  s3OutputPrefix: string; // e.g., "bedrock-jobs/output/"

  // Database Configuration
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;

  // Model Configuration
  modelId: string; // e.g., "anthropic.claude-sonnet-4-5-20250929-v1:0"
  jobType: 'retrieval-summary' | 'text-embed';

  // Batching Configuration
  batchSize?: number; // Default: 100 (AWS minimum)
  maxBatchSize?: number; // Default: 50000 (AWS maximum)
  maxFileSizeBytes?: number; // Default: 1GB
  maxJobSizeBytes?: number; // Default: 5GB

  // Polling Configuration
  pollIntervalMs?: number; // Default: 30000 (30 seconds)
  enableAutoPolling?: boolean; // Default: true

  // Retry Configuration
  retryMode?: 'standard' | 'adaptive' | 'legacy';
  maxAttempts?: number;

  // Throttling Backoff Configuration
  throttleBackoff?: ThrottleBackoffConfig;
}

/**
 * Bedrock task input format
 */
export interface BedrockTask {
  recordId: string;
  modelInput: Record<string, any>; // Model-specific input format
}

/**
 * Job status enum matching database schema and AWS Bedrock ModelInvocationJobStatus
 * Maps to all possible statuses from AWS Bedrock batch inference jobs
 */
export type JobStatus = 
  | 'queued'              // SUBMITTED - Job has been submitted
  | 'scheduled'           // SCHEDULED - Job is scheduled to run
  | 'validating'          // VALIDATING - Job input is being validated
  | 'in-process'          // IN_PROGRESS - Job is currently processing
  | 'partially-completed' // PARTIALLY_COMPLETED - Job completed with some failures
  | 'completed'           // COMPLETED - Job completed successfully
  | 'expired'             // EXPIRED - Job expired before completion
  | 'stopping'            // STOPPING - Job is being stopped
  | 'stopped'             // STOPPED - Job was stopped
  | 'failed';             // FAILED - Job failed

/**
 * Job type enum matching database schema
 */
export type JobType = 'retrieval-summary' | 'text-embed';

/**
 * Database record for batch inference job
 */
export interface JobRecord {
  id: string;
  type: JobType;
  status: JobStatus;
  createdAt: Date;
  updatedAt: Date;
  jobArn?: string;
  s3InputUri?: string;
  s3OutputUri?: string;
  errorMessage?: string;
  modelId?: string;
  recordCount?: number;
}

/**
 * Task result from batch inference output
 */
export interface TaskResult {
  recordId: string;
  modelOutput?: any;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Job result containing job information and task results
 */
export interface JobResult {
  jobId: string;
  status: JobStatus;
  jobArn?: string;
  s3InputUri?: string;
  s3OutputUri?: string;
  recordCount?: number;
  errorMessage?: string | undefined;
  results?: TaskResult[];
}

/**
 * Event types emitted by BedrockQueue
 */
export interface QueueEvents {
  'task-queued': (task: BedrockTask) => void;
  'batch-flushed': (jobId: string, recordCount: number) => void;
  'job-queued': (jobId: string, jobArn: string) => void;
  'job-status-changed': (jobId: string, status: JobStatus) => void;
  'job-completed': (jobId: string, result: JobResult) => void;
  'job-failed': (jobId: string, error: string) => void;
  'error': (error: Error) => void;
}

/**
 * Database connection configuration
 */
export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/**
 * S3 configuration
 */
export interface S3Config {
  inputBucket: string;
  inputPrefix: string;
  outputBucket: string;
  outputPrefix: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  retryMode?: 'standard' | 'adaptive' | 'legacy';
  maxAttempts?: number;
}

/**
 * AWS Bedrock configuration
 */
export interface BedrockConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  roleArn: string;
  retryMode?: 'standard' | 'adaptive' | 'legacy';
  maxAttempts?: number;
  throttleBackoff?: ThrottleBackoffConfig;
}

/**
 * Throttled request backoff configuration
 */
export interface ThrottleBackoffConfig {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
  jitterRatio?: number;
}

