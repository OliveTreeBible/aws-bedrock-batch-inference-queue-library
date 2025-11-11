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
   * Maps all ModelInvocationJobStatus values from AWS SDK
   */
  private mapBedrockStatusToJobStatus(
    bedrockStatus: ModelInvocationJobStatus | string | undefined
  ): JobStatus {
    switch (bedrockStatus) {
      case 'Submitted':
        return 'queued';
      case 'Scheduled':
        return 'scheduled';
      case 'Validating':
        return 'validating';
      case 'InProgress':
        return 'in-process';
      case 'PartiallyCompleted':
        return 'partially-completed';
      case 'Completed':
        return 'completed';
      case 'Expired':
        return 'expired';
      case 'Stopping':
        return 'stopping';
      case 'Stopped':
        return 'stopped';
      case 'Failed':
        return 'failed';
      default:
        // Default to queued for unknown statuses
        return 'queued';
    }
  }

  /**
   * Check if a job status is terminal (job will not transition to another status)
   * Terminal states: completed, partially-completed, failed, expired, stopped
   * Non-terminal states: queued, scheduled, validating, in-process, stopping
   */
  private isTerminalStatus(status: JobStatus): boolean {
    return [
      'completed',
      'partially-completed',
      'failed',
      'expired',
      'stopped',
    ].includes(status);
  }

  /**
   * Check if a job status indicates success (has results available)
   * Success states: completed, partially-completed
   */
  private isSuccessStatus(status: JobStatus): boolean {
    return status === 'completed' || status === 'partially-completed';
  }

  /**
   * Check if a job status indicates failure (no results available)
   * Failure states: failed, expired, stopped
   */
  private isFailureStatus(status: JobStatus): boolean {
    return status === 'failed' || status === 'expired' || status === 'stopped';
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

      // Emit specific completion events for terminal states
      if (this.isSuccessStatus(status)) {
        // Emit job-completed for both 'completed' and 'partially-completed'
        // as both have results available (partially-completed may have some failures)
        const jobRecord = await this.databaseManager.getJob(jobId);
        const jobResult: JobResult = {
          jobId,
          status,
          jobArn,
          s3InputUri: jobRecord?.s3InputUri,
          s3OutputUri: outputS3Uri || jobRecord?.s3OutputUri,
          recordCount: jobRecord?.recordCount,
          errorMessage: failureMessage,
        };
        this.emit('job-completed', jobId, jobResult);
      } else if (this.isFailureStatus(status)) {
        // Emit job-failed for failed, expired, and stopped states
        const errorMsg = failureMessage || 
          (status === 'expired' ? 'Job expired before completion' :
           status === 'stopped' ? 'Job was stopped' :
           'Job failed');
        this.emit('job-failed', jobId, errorMsg);
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

        // Stop polling if job has reached a terminal state
        if (this.isTerminalStatus(status)) {
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
   * Wait for job to reach a terminal state (poll until terminal status)
   * Terminal states: completed, partially-completed, failed, expired, stopped
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

      // Return when job reaches any terminal state
      if (this.isTerminalStatus(status)) {
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

