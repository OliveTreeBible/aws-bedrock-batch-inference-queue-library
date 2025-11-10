import { Pool, Client, QueryResult } from 'pg';
import { DatabaseConfig, JobRecord, JobStatus, JobType } from './types';

/**
 * DatabaseManager handles all PostgreSQL operations for job tracking
 */
export class DatabaseManager {
  private pool: Pool;
  private config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = config;
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
    });

    // Handle pool errors
    this.pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
    });
  }

  /**
   * Test database connection
   */
  async connect(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT NOW()');
    } finally {
      client.release();
    }
  }

  /**
   * Close database connection pool
   */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Insert a new job record
   */
  async insertJob(
    jobId: string,
    jobType: JobType,
    status: JobStatus,
    modelId: string,
    recordCount: number,
    jobArn?: string,
    s3InputUri?: string,
    s3OutputUri?: string
  ): Promise<void> {
    const query = `
      INSERT INTO batch_inference_jobs (
        id, type, status, created_at, updated_at,
        job_arn, s3_input_uri, s3_output_uri, model_id, record_count
      )
      VALUES ($1, $2, $3, NOW(), NOW(), $4, $5, $6, $7, $8)
    `;

    await this.pool.query(query, [
      jobId,
      jobType,
      status,
      jobArn || null,
      s3InputUri || null,
      s3OutputUri || null,
      modelId,
      recordCount,
    ]);
  }

  /**
   * Update job status
   */
  async updateJobStatus(
    jobId: string,
    status: JobStatus,
    jobArn?: string,
    s3OutputUri?: string,
    errorMessage?: string
  ): Promise<void> {
    const updates: string[] = ['status = $2', 'updated_at = NOW()'];
    const values: any[] = [jobId, status];
    let paramIndex = 3;

    if (jobArn !== undefined) {
      updates.push(`job_arn = $${paramIndex}`);
      values.push(jobArn);
      paramIndex++;
    }

    if (s3OutputUri !== undefined) {
      updates.push(`s3_output_uri = $${paramIndex}`);
      values.push(s3OutputUri);
      paramIndex++;
    }

    if (errorMessage !== undefined) {
      updates.push(`error_message = $${paramIndex}`);
      values.push(errorMessage);
      paramIndex++;
    }

    const query = `UPDATE batch_inference_jobs SET ${updates.join(', ')} WHERE id = $1`;
    await this.pool.query(query, values);
  }

  /**
   * Get job record by ID
   */
  async getJob(jobId: string): Promise<JobRecord | null> {
    const query = `
      SELECT 
        id, type, status, created_at, updated_at,
        job_arn, s3_input_uri, s3_output_uri, error_message, model_id, record_count
      FROM batch_inference_jobs
      WHERE id = $1
    `;

    const result: QueryResult = await this.pool.query(query, [jobId]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      jobArn: row.job_arn || undefined,
      s3InputUri: row.s3_input_uri || undefined,
      s3OutputUri: row.s3_output_uri || undefined,
      errorMessage: row.error_message || undefined,
      modelId: row.model_id || undefined,
      recordCount: row.record_count || undefined,
    };
  }

  /**
   * Get all jobs with a specific status
   */
  async getJobsByStatus(status: JobStatus): Promise<JobRecord[]> {
    const query = `
      SELECT 
        id, type, status, created_at, updated_at,
        job_arn, s3_input_uri, s3_output_uri, error_message, model_id, record_count
      FROM batch_inference_jobs
      WHERE status = $1
      ORDER BY created_at DESC
    `;

    const result: QueryResult = await this.pool.query(query, [status]);
    return result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      jobArn: row.job_arn || undefined,
      s3InputUri: row.s3_input_uri || undefined,
      s3OutputUri: row.s3_output_uri || undefined,
      errorMessage: row.error_message || undefined,
      modelId: row.model_id || undefined,
      recordCount: row.record_count || undefined,
    }));
  }

  /**
   * Get the underlying pool (for advanced usage)
   */
  getPool(): Pool {
    return this.pool;
  }
}

