import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { S3Config } from './types';

/**
 * S3Manager handles all S3 operations for input and output files
 */
export class S3Manager {
  private s3Client: S3Client;
  private config: S3Config;

  constructor(config: S3Config) {
    this.config = config;
    this.s3Client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  /**
   * Upload JSONL file to S3 input location
   * @param jobId Job UUID
   * @param jsonlContent JSONL file content
   * @returns S3 URI of the uploaded file
   */
  async uploadInputFile(jobId: string, jsonlContent: string): Promise<string> {
    const key = `${this.config.inputPrefix}${jobId}.jsonl`;
    const bucket = this.config.inputBucket;

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: jsonlContent,
      ContentType: 'application/x-ndjson',
    });

    await this.s3Client.send(command);

    return `s3://${bucket}/${key}`;
  }

  /**
   * Download output file from S3
   * @param jobId Job UUID
   * @returns JSONL content of the output file
   */
  async downloadOutputFile(jobId: string): Promise<string> {
    // First, list objects in the output prefix to find the output file
    // AWS Bedrock creates output files with a specific naming pattern
    const listCommand = new ListObjectsV2Command({
      Bucket: this.config.outputBucket,
      Prefix: `${this.config.outputPrefix}${jobId}/`,
    });

    const listResponse = await this.s3Client.send(listCommand);

    if (!listResponse.Contents || listResponse.Contents.length === 0) {
      throw new Error(`No output files found for job ${jobId}`);
    }

    // Find the output JSONL file (usually ends with .jsonl or .jsonl.out)
    const outputFile = listResponse.Contents.find(
      (obj) => obj.Key && (obj.Key.endsWith('.jsonl') || obj.Key.endsWith('.jsonl.out'))
    );

    if (!outputFile || !outputFile.Key) {
      throw new Error(`No JSONL output file found for job ${jobId}`);
    }

    // Download the output file
    const getCommand = new GetObjectCommand({
      Bucket: this.config.outputBucket,
      Key: outputFile.Key,
    });

    const response = await this.s3Client.send(getCommand);

    if (!response.Body) {
      throw new Error(`Output file for job ${jobId} is empty`);
    }

    // Convert stream to string
    // AWS SDK v3 Body can be a Readable stream in Node.js
    const stream = response.Body as any;
    
    // Handle both Node.js streams and web streams
    if (typeof stream.transformToWebStream === 'function') {
      // Web stream (browser/Deno)
      const chunks: Uint8Array[] = [];
      const reader = stream.transformToWebStream().getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }

      const buffer = Buffer.concat(chunks);
      return buffer.toString('utf-8');
    } else {
      // Node.js Readable stream
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString('utf-8');
    }
  }

  /**
   * Get the output S3 URI for a job
   * @param jobId Job UUID
   * @returns S3 URI of the output location
   */
  getOutputUri(jobId: string): string {
    return `s3://${this.config.outputBucket}/${this.config.outputPrefix}${jobId}/`;
  }

  /**
   * Get the input S3 URI for a job
   * @param jobId Job UUID
   * @returns S3 URI of the input file
   */
  getInputUri(jobId: string): string {
    return `s3://${this.config.inputBucket}/${this.config.inputPrefix}${jobId}.jsonl`;
  }

  /**
   * Check if output file exists for a job
   * @param jobId Job UUID
   * @returns true if output file exists, false otherwise
   */
  async outputFileExists(jobId: string): Promise<boolean> {
    try {
      const listCommand = new ListObjectsV2Command({
        Bucket: this.config.outputBucket,
        Prefix: `${this.config.outputPrefix}${jobId}/`,
        MaxKeys: 1,
      });

      const response = await this.s3Client.send(listCommand);
      return (response.Contents?.length ?? 0) > 0;
    } catch (error) {
      return false;
    }
  }
}

