import { EventEmitter } from 'events';
import {
  BedrockClient,
  CreateModelInvocationJobCommand,
} from '@aws-sdk/client-bedrock';
import { DatabaseManager } from './database-manager';
import { S3Manager } from './s3-manager';
import { JobTracker } from './job-tracker';
import {
  BedrockQueueConfig,
  BedrockTask,
  JobResult,
  JobStatus,
  DatabaseConfig,
  S3Config,
  BedrockConfig,
  TaskResult,
} from './types';
import {
  generateUUID,
  tasksToJSONL,
  jsonlToTaskResults,
  estimateBatchSize,
  validateBatchSize,
  BEDROCK_LIMITS,
} from './utils';
import {
  resolveRetrySettings,
  resolveThrottleBackoff,
  retryOnThrottle,
  ResolvedThrottleBackoff,
  isThrottlingError,
} from './retry';

/**
 * BedrockQueue - Main class for queuing and processing LLM tasks via AWS Bedrock batch inference
 */
export class BedrockQueue extends EventEmitter {
  private config: BedrockQueueConfig;
  private queue: BedrockTask[] = [];
  private databaseManager: DatabaseManager;
  private s3Manager: S3Manager;
  private jobTracker: JobTracker;
  private bedrockClient: BedrockClient;
  private batchSize: number;
  private maxBatchSize: number;
  private maxFileSizeBytes: number;
  private maxJobSizeBytes: number;
  private throttleBackoff: ResolvedThrottleBackoff;

  constructor(config: BedrockQueueConfig) {
    super();

    // Set defaults
    this.config = config;
    this.batchSize = config.batchSize ?? BEDROCK_LIMITS.MIN_RECORDS;
    this.maxBatchSize = config.maxBatchSize ?? BEDROCK_LIMITS.MAX_RECORDS;
    this.maxFileSizeBytes = config.maxFileSizeBytes ?? BEDROCK_LIMITS.MAX_FILE_SIZE_BYTES;
    this.maxJobSizeBytes = config.maxJobSizeBytes ?? BEDROCK_LIMITS.MAX_JOB_SIZE_BYTES;

    // Validate batch size
    if (this.batchSize < BEDROCK_LIMITS.MIN_RECORDS) {
      throw new Error(
        `batchSize must be at least ${BEDROCK_LIMITS.MIN_RECORDS} (AWS Bedrock minimum)`
      );
    }

    if (this.batchSize > this.maxBatchSize) {
      throw new Error('batchSize cannot exceed maxBatchSize');
    }

    // Initialize database manager
    const dbConfig: DatabaseConfig = {
      host: config.dbHost,
      port: config.dbPort,
      database: config.dbName,
      user: config.dbUser,
      password: config.dbPassword,
    };
    this.databaseManager = new DatabaseManager(dbConfig);

    // Initialize S3 manager
    const retrySettings = resolveRetrySettings({
      retryMode: config.retryMode,
      maxAttempts: config.maxAttempts,
    });
    this.throttleBackoff = resolveThrottleBackoff(config.throttleBackoff);
    const s3Config: S3Config = {
      inputBucket: config.s3InputBucket,
      inputPrefix: config.s3InputPrefix,
      outputBucket: config.s3OutputBucket,
      outputPrefix: config.s3OutputPrefix,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      retryMode: retrySettings.retryMode,
      maxAttempts: retrySettings.maxAttempts,
    };
    this.s3Manager = new S3Manager(s3Config);

    // Initialize Bedrock client
    const bedrockConfig: BedrockConfig = {
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      roleArn: config.roleArn,
      retryMode: retrySettings.retryMode,
      maxAttempts: retrySettings.maxAttempts,
      throttleBackoff: config.throttleBackoff,
    };
    this.bedrockClient = new BedrockClient({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      retryMode: retrySettings.retryMode,
      maxAttempts: retrySettings.maxAttempts,
    });

    // Initialize job tracker
    this.jobTracker = new JobTracker(
      bedrockConfig,
      this.databaseManager,
      this.s3Manager,
      config.pollIntervalMs ?? 30000,
      config.enableAutoPolling ?? true,
      this.throttleBackoff
    );

    // Forward job tracker events
    this.jobTracker.on('job-status-changed', (jobId: string, status: JobStatus) => {
      this.emit('job-status-changed', jobId, status);
    });

    this.jobTracker.on('job-completed', (jobId: string, result: JobResult) => {
      this.emit('job-completed', jobId, result);
    });

    this.jobTracker.on('job-failed', (jobId: string, error: string) => {
      this.emit('job-failed', jobId, error);
    });

    this.jobTracker.on('error', (error: Error) => {
      this.emit('error', error);
    });
  }

  /**
   * Initialize the queue (test database connection)
   */
  async initialize(): Promise<void> {
    try {
      await this.databaseManager.connect();
    } catch (error: any) {
      this.emit('error', new Error(`Failed to initialize database: ${error.message}`));
      throw error;
    }
  }

  /**
   * Add a task to the queue
   * Automatically flushes if threshold is reached
   */
  async enqueue(task: BedrockTask): Promise<void> {
    try {
      this.queue.push(task);
      this.emit('task-queued', task);

      // Check if we should auto-flush
      const shouldFlush = this.shouldFlush();
      if (shouldFlush) {
        await this.flush();
      }
    } catch (error: any) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Check if queue should be flushed
   */
  private shouldFlush(): boolean {
    if (this.queue.length === 0) {
      return false;
    }

    // Check record count
    if (this.queue.length >= this.batchSize) {
      return true;
    }

    // Check file size
    const estimatedSize = estimateBatchSize(this.queue);
    if (estimatedSize >= this.maxFileSizeBytes) {
      return true;
    }

    // Check if adding one more task would exceed max batch size
    if (this.queue.length >= this.maxBatchSize) {
      return true;
    }

    return false;
  }

  /**
   * Flush the queue and create a batch inference job
   * @returns Job UUID
   */
  async flush(): Promise<string> {
    if (this.queue.length === 0) {
      throw new Error('Cannot flush empty queue');
    }

    const tasksToProcess = [...this.queue];
    let queueCleared = false;
    try {
      // Generate job ID
      const jobId = generateUUID();

      // Validate batch size
      const estimatedSize = estimateBatchSize(tasksToProcess);
      const validation = validateBatchSize(tasksToProcess.length, estimatedSize);

      if (!validation.isValid) {
        throw new Error(validation.error);
      }

      // Convert tasks to JSONL
      const jsonlContent = tasksToJSONL(tasksToProcess);
      this.queue = []; // Clear queue
      queueCleared = true;

      // Upload to S3
      const s3InputUri = await this.s3Manager.uploadInputFile(jobId, jsonlContent);
      const s3OutputUri = this.s3Manager.getOutputUri(jobId);

      // Create batch inference job
      const jobName = `bedrock-batch-${jobId}`;
      const command = new CreateModelInvocationJobCommand({
        jobName,
        modelId: this.config.modelId,
        roleArn: this.config.roleArn,
        inputDataConfig: {
          s3InputDataConfig: {
            s3Uri: s3InputUri,
          },
        },
        outputDataConfig: {
          s3OutputDataConfig: {
            s3Uri: s3OutputUri,
          },
        },
        clientRequestToken: jobId, // Use jobId as client request token for idempotency
      });

      const response = await retryOnThrottle(
        () => this.bedrockClient.send(command),
        { backoff: this.throttleBackoff }
      );
      const jobArn = response.jobArn;

      if (!jobArn) {
        throw new Error('Failed to create job: no jobArn returned');
      }

      // Insert job record in database
      await this.databaseManager.insertJob(
        jobId,
        this.config.jobType,
        'queued',
        this.config.modelId,
        tasksToProcess.length,
        jobArn,
        s3InputUri,
        s3OutputUri
      );

      // Emit events
      this.emit('batch-flushed', jobId, tasksToProcess.length);
      this.emit('job-queued', jobId, jobArn);

      // Start polling if enabled
      if (this.config.enableAutoPolling !== false) {
        this.jobTracker.startPolling(jobId, jobArn);
      }

      return jobId;
    } catch (error: any) {
      if (queueCleared && tasksToProcess.length > 0 && isThrottlingError(error)) {
        this.queue.unshift(...tasksToProcess);
      }
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get current queue size
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Get job status
   */
  async getJobStatus(jobId: string): Promise<JobStatus> {
    try {
      const job = await this.databaseManager.getJob(jobId);
      if (!job) {
        throw new Error(`Job ${jobId} not found`);
      }

      // If job has ARN and auto-polling is enabled, check latest status
      if (job.jobArn && this.config.enableAutoPolling !== false) {
        await this.jobTracker.pollJobStatus(jobId, job.jobArn);
        const updatedJob = await this.databaseManager.getJob(jobId);
        return updatedJob?.status || job.status;
      }

      return job.status;
    } catch (error: any) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get job results from S3
   * Results are available for 'completed' and 'partially-completed' statuses
   */
  async getJobResults(jobId: string): Promise<TaskResult[]> {
    try {
      const job = await this.databaseManager.getJob(jobId);
      if (!job) {
        throw new Error(`Job ${jobId} not found`);
      }

      // Results are available for both completed and partially-completed statuses
      if (job.status !== 'completed' && job.status !== 'partially-completed') {
        throw new Error(
          `Job ${jobId} does not have results available. Current status: ${job.status}. ` +
          `Results are only available for 'completed' or 'partially-completed' statuses.`
        );
      }

      if (!job.s3OutputUri) {
        throw new Error(`Job ${jobId} has no output S3 URI`);
      }

      // Download output file from S3
      const jsonlContent = await this.s3Manager.downloadOutputFile(jobId);
      const results = jsonlToTaskResults(jsonlContent);

      return results;
    } catch (error: any) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Wait for job to reach a terminal state
   * Terminal states: completed, partially-completed, failed, expired, stopped
   * Returns job result with results if status is completed or partially-completed
   */
  async awaitJob(jobId: string): Promise<JobResult> {
    try {
      const job = await this.databaseManager.getJob(jobId);
      if (!job) {
        throw new Error(`Job ${jobId} not found`);
      }

      if (!job.jobArn) {
        throw new Error(`Job ${jobId} has no jobArn`);
      }

      // Wait for job to reach a terminal state
      const status = await this.jobTracker.waitForJobCompletion(jobId, job.jobArn);

      // Get updated job record
      const updatedJob = await this.databaseManager.getJob(jobId);
      if (!updatedJob) {
        throw new Error(`Job ${jobId} not found after completion`);
      }

      // Get results if job completed successfully (completed or partially-completed)
      // Both statuses have results available, though partially-completed may have some failures
      let results: TaskResult[] | undefined;
      if (status === 'completed' || status === 'partially-completed') {
        try {
          results = await this.getJobResults(jobId);
        } catch (error) {
          // Results might not be available immediately, that's OK
          this.emit('error', new Error(`Failed to retrieve results for job ${jobId}: ${error}`));
        }
      }

      const jobResult: JobResult = {
        jobId,
        status: updatedJob.status,
        jobArn: updatedJob.jobArn,
        s3InputUri: updatedJob.s3InputUri,
        s3OutputUri: updatedJob.s3OutputUri,
        errorMessage: updatedJob.errorMessage,
        results,
        recordCount: updatedJob.recordCount,
      };

      return jobResult;
    } catch (error: any) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Wait for multiple jobs to complete (Promise.all equivalent)
   */
  async awaitJobs(jobIds: string[]): Promise<JobResult[]> {
    try {
      const promises = jobIds.map((jobId) => this.awaitJob(jobId));
      return await Promise.all(promises);
    } catch (error: any) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Close connections and cleanup
   */
  async close(): Promise<void> {
    try {
      // Stop all polling
      this.jobTracker.stopAllPolling();

      // Close database connection
      await this.databaseManager.close();
    } catch (error: any) {
      this.emit('error', error);
      throw error;
    }
  }
}

// Export types
export * from './types';
export { DatabaseManager } from './database-manager';
export { S3Manager } from './s3-manager';
export { JobTracker } from './job-tracker';
export { TokenBucket } from './token-bucket';

