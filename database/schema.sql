-- Drop existing types if they exist
DROP TYPE IF EXISTS "public"."job_type";
DROP TYPE IF EXISTS "public"."job_status";

-- Create job_type enum
CREATE TYPE "public"."job_type" AS ENUM ('retrieval-summary', 'text-embed');

-- Create job_status enum
CREATE TYPE "public"."job_status" AS ENUM ('failed', 'completed', 'queued', 'in-process');

-- Drop table if it exists
DROP TABLE IF EXISTS "public"."batch_inference_jobs";

-- Create batch_inference_jobs table with enhanced schema
CREATE TABLE "public"."batch_inference_jobs" (
    "id" uuid NOT NULL,
    "type" "public"."job_type" NOT NULL,
    "status" "public"."job_status" NOT NULL,
    "created_at" timestamp NOT NULL,
    "updated_at" timestamp NOT NULL,
    "job_arn" text,
    "s3_input_uri" text,
    "s3_output_uri" text,
    "error_message" text,
    "model_id" text,
    "record_count" integer,
    PRIMARY KEY ("id")
);

-- Create index on status for faster queries
CREATE INDEX "idx_batch_inference_jobs_status" ON "public"."batch_inference_jobs" ("status");

-- Create index on created_at for chronological queries
CREATE INDEX "idx_batch_inference_jobs_created_at" ON "public"."batch_inference_jobs" ("created_at");

-- Create index on job_arn for AWS job lookups
CREATE INDEX "idx_batch_inference_jobs_job_arn" ON "public"."batch_inference_jobs" ("job_arn");

-- Add comments for documentation
COMMENT ON TABLE "public"."batch_inference_jobs" IS 'Tracks AWS Bedrock batch inference jobs';
COMMENT ON COLUMN "public"."batch_inference_jobs"."id" IS 'Unique job identifier (UUID)';
COMMENT ON COLUMN "public"."batch_inference_jobs"."type" IS 'Type of job: retrieval-summary or text-embed';
COMMENT ON COLUMN "public"."batch_inference_jobs"."status" IS 'Current status of the job';
COMMENT ON COLUMN "public"."batch_inference_jobs"."job_arn" IS 'AWS Bedrock job ARN';
COMMENT ON COLUMN "public"."batch_inference_jobs"."s3_input_uri" IS 'S3 URI of the input JSONL file';
COMMENT ON COLUMN "public"."batch_inference_jobs"."s3_output_uri" IS 'S3 URI of the output directory';
COMMENT ON COLUMN "public"."batch_inference_jobs"."error_message" IS 'Error message if job failed';
COMMENT ON COLUMN "public"."batch_inference_jobs"."model_id" IS 'AWS Bedrock model identifier';
COMMENT ON COLUMN "public"."batch_inference_jobs"."record_count" IS 'Number of records in the batch';

