import { v4 as uuidv4 } from 'uuid';
import { BedrockTask, TaskResult } from './types';

/**
 * Generate a random UUID
 */
export function generateUUID(): string {
  return uuidv4();
}

/**
 * Convert an array of tasks to JSONL format
 * @param tasks Array of BedrockTask objects
 * @returns JSONL string (newline-delimited JSON)
 */
export function tasksToJSONL(tasks: BedrockTask[]): string {
  return tasks.map(task => JSON.stringify(task)).join('\n');
}

/**
 * Parse JSONL string to array of task results
 * @param jsonl JSONL string (newline-delimited JSON)
 * @returns Array of TaskResult objects
 */
export function jsonlToTaskResults(jsonl: string): TaskResult[] {
  const lines = jsonl.trim().split('\n').filter(line => line.length > 0);
  return lines.map(line => {
    try {
      return JSON.parse(line) as TaskResult;
    } catch (error) {
      throw new Error(`Failed to parse JSONL line: ${line}. Error: ${error}`);
    }
  });
}

/**
 * Estimate the byte size of a task
 * @param task BedrockTask object
 * @returns Estimated byte size
 */
export function estimateTaskSize(task: BedrockTask): number {
  return Buffer.byteLength(JSON.stringify(task), 'utf8');
}

/**
 * Estimate the total byte size of an array of tasks
 * @param tasks Array of BedrockTask objects
 * @returns Estimated total byte size (including newline characters)
 */
export function estimateBatchSize(tasks: BedrockTask[]): number {
  if (tasks.length === 0) {
    return 0;
  }
  // Estimate: sum of task sizes + newline characters (1 byte per task)
  const taskSizes = tasks.map(estimateTaskSize);
  const totalTaskSize = taskSizes.reduce((sum, size) => sum + size, 0);
  // Add newline characters (tasks.length - 1 newlines between tasks)
  return totalTaskSize + (tasks.length - 1);
}

/**
 * Convert bytes to human-readable format
 * @param bytes Number of bytes
 * @returns Human-readable string (e.g., "1.5 MB")
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Default constants for AWS Bedrock batch inference limits
 */
export const BEDROCK_LIMITS = {
  MIN_RECORDS: 100,
  MAX_RECORDS: 5000,
  MAX_FILE_SIZE_BYTES: 1024 * 1024 * 1024, // 1 GB
  MAX_JOB_SIZE_BYTES: 5 * 1024 * 1024 * 1024, // 5 GB
} as const;

/**
 * Validate batch size against AWS Bedrock limits
 * @param recordCount Number of records
 * @param estimatedSize Estimated size in bytes
 * @returns Object with isValid flag and error message if invalid
 */
export function validateBatchSize(
  recordCount: number,
  estimatedSize: number
): { isValid: boolean; error?: string } {
  if (recordCount < BEDROCK_LIMITS.MIN_RECORDS) {
    return {
      isValid: false,
      error: `Batch must have at least ${BEDROCK_LIMITS.MIN_RECORDS} records. Found ${recordCount}.`,
    };
  }

  if (recordCount > BEDROCK_LIMITS.MAX_RECORDS) {
    return {
      isValid: false,
      error: `Batch cannot have more than ${BEDROCK_LIMITS.MAX_RECORDS} records. Found ${recordCount}.`,
    };
  }

  if (estimatedSize > BEDROCK_LIMITS.MAX_FILE_SIZE_BYTES) {
    return {
      isValid: false,
      error: `Batch size exceeds maximum file size of ${formatBytes(BEDROCK_LIMITS.MAX_FILE_SIZE_BYTES)}. Estimated: ${formatBytes(estimatedSize)}.`,
    };
  }

  return { isValid: true };
}

