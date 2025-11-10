import {
  BedrockClient,
  GetModelInvocationJobCommand,
  ModelInvocationJobStatus,
} from '@aws-sdk/client-bedrock';
import { EventEmitter } from 'events';
import { DatabaseManager } from './database-manager';
import { S3Manager } from './s3-manager';
import { BedrockConfig, JobStatus, JobResult } from './types';

/**
 * JobTracker handles polling AWS Bedrock job status and updating the database
 */
export class JobTracker extends EventEmitter {
  private bedrockClient: BedrockClient;
  private databaseManager: DatabaseManager;
  private s3Manager: S3Manager;
  private pollIntervalMs: number;
  private enableAutoPolling: boolean;
  private pollingIntervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    bedrockConfig: BedrockConfig,
    databaseManager: DatabaseManager,
    s3Manager: S3Manager,
    pollIntervalMs: number = 30000,
    enableAutoPolling: boolean = true
  ) {
    super();
    this.bedrockClient = new BedrockClient({
      region: bedrockConfig.region,
      credentials: {
        accessKeyId: bedrockConfig.accessKeyId,
        secretAccessKey: bedrockConfig.secretAccessKey,
      },
    });
    this.databaseManager = databaseManager;
    this.s3Manager = s3Manager;
    this.pollIntervalMs = pollIntervalMs;
    this.enableAutoPolling = enableAutoPolling;
  }

  /**
   * Map AWS Bedrock job status to our JobStatus type
   */
  private mapBedrockStatusToJobStatus(
    bedrockStatus: ModelInvocationJobStatus | string | undefined
  ): JobStatus {
    switch (bedrockStatus) {
      case 'InProgress':
        return 'in-process';
      case 'Completed':
        return 'completed';
      case 'Failed':
      case 'Stopped':
      case 'Stopping':
        return 'failed';
      case 'Submitted':
      default:
        return 'queued';
    }
  }

  /**
   * Check job status from AWS Bedrock
   */
  async checkJobStatus(jobArn: string): Promise<{
    status: JobStatus;
    outputS3Uri?: string;
    failureMessage?: string;
  }> {
    const command = new GetModelInvocationJobCommand({
      jobIdentifier: jobArn,
    });

    try {
      const response = await this.bedrockClient.send(command);
      const status = this.mapBedrockStatusToJobStatus(response.status);
      const outputS3Uri = response.outputDataConfig?.s3OutputDataConfig?.s3Uri;
      const failureMessage = response.message; // AWS uses 'message' property for failure messages

      return {
        status,
        outputS3Uri,
        failureMessage,
      };
    } catch (error: any) {
      throw new Error(`Failed to check job status for ${jobArn}: ${error.message}`);
    }
  }

  /**
   * Update job status in database and emit events
   */
  private async updateJobStatus(
    jobId: string,
    jobArn: string,
    status: JobStatus,
    outputS3Uri?: string,
    failureMessage?: string
  ): Promise<void> {
    // Get current job record
    const currentJob = await this.databaseManager.getJob(jobId);
    if (!currentJob) {
      throw new Error(`Job ${jobId} not found in database`);
    }

    // Only update if status has changed
    if (currentJob.status !== status) {
      await this.databaseManager.updateJobStatus(
        jobId,
        status,
        jobArn,
        outputS3Uri,
        failureMessage
      );

      // Emit status change event
      this.emit('job-status-changed', jobId, status);

      // Emit specific completion events
      if (status === 'completed') {
        const jobRecord = await this.databaseManager.getJob(jobId);
        const jobResult: JobResult = {
          jobId,
          status,
          jobArn,
          s3InputUri: jobRecord?.s3InputUri,
          s3OutputUri: outputS3Uri || jobRecord?.s3OutputUri,
          recordCount: jobRecord?.recordCount,
        };
        this.emit('job-completed', jobId, jobResult);
      } else if (status === 'failed') {
        this.emit('job-failed', jobId, failureMessage || 'Job failed');
      }
    }
  }

  /**
   * Poll job status once
   */
  async pollJobStatus(jobId: string, jobArn: string): Promise<JobStatus> {
    try {
      const { status, outputS3Uri, failureMessage } = await this.checkJobStatus(jobArn);
      await this.updateJobStatus(jobId, jobArn, status, outputS3Uri, failureMessage);
      return status;
    } catch (error: any) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Start automatic polling for a job
   */
  startPolling(jobId: string, jobArn: string): void {
    if (!this.enableAutoPolling) {
      return;
    }

    // Stop existing polling if any
    this.stopPolling(jobId);

    // Poll immediately
    this.pollJobStatus(jobId, jobArn).catch((error) => {
      this.emit('error', error);
    });

    // Set up interval polling
    const interval = setInterval(async () => {
      try {
        const status = await this.pollJobStatus(jobId, jobArn);

        // Stop polling if job is completed or failed
        if (status === 'completed' || status === 'failed') {
          this.stopPolling(jobId);
        }
      } catch (error) {
        // Error is already emitted in pollJobStatus
        // Continue polling on error (job might still be processing)
      }
    }, this.pollIntervalMs);

    this.pollingIntervals.set(jobId, interval);
  }

  /**
   * Stop automatic polling for a job
   */
  stopPolling(jobId: string): void {
    const interval = this.pollingIntervals.get(jobId);
    if (interval) {
      clearInterval(interval);
      this.pollingIntervals.delete(jobId);
    }
  }

  /**
   * Stop all polling
   */
  stopAllPolling(): void {
    for (const [jobId, interval] of this.pollingIntervals.entries()) {
      clearInterval(interval);
    }
    this.pollingIntervals.clear();
  }

  /**
   * Wait for job to complete (poll until completed or failed)
   */
  async waitForJobCompletion(
    jobId: string,
    jobArn: string,
    timeoutMs?: number
  ): Promise<JobStatus> {
    const startTime = Date.now();
    const timeout = timeoutMs || Infinity;

    while (true) {
      const status = await this.pollJobStatus(jobId, jobArn);

      if (status === 'completed' || status === 'failed') {
        return status;
      }

      // Check timeout
      if (Date.now() - startTime > timeout) {
        throw new Error(`Job ${jobId} did not complete within ${timeoutMs}ms`);
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }
}

