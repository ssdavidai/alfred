import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

export enum JobQueues {
  VM_PROVISION = 'vm-provision',
  VM_DEPROVISION = 'vm-deprovision',
  VM_STATUS_CHECK = 'vm-status-check',
}

// Store queues and workers
const queues = new Map<string, Queue>();
const workers = new Map<string, Worker>();
let redisConnection: Redis | null = null;

// Get Redis connection configuration
function getRedisConfig() {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

  // Parse Redis URL
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: parseInt(url.port) || 6379,
    password: url.password || undefined,
    db: url.pathname ? parseInt(url.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null, // Required by BullMQ
  };
}

// Initialize Redis connection
export function getRedisConnection(): Redis {
  if (!redisConnection) {
    const config = getRedisConfig();
    redisConnection = new Redis(config);

    redisConnection.on('error', (error: Error) => {
      console.error('Redis connection error:', error);
    });

    redisConnection.on('connect', () => {
      console.log('Redis connected successfully');
    });
  }

  return redisConnection;
}

// Get or create a queue
export function getQueue(queueName: string): Queue {
  if (!queues.has(queueName)) {
    const connection = getRedisConnection();
    const queue = new Queue(queueName, {
      connection: connection as any,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          count: 100,
          age: 7 * 24 * 60 * 60, // 7 days
        },
        removeOnFail: {
          count: 1000,
        },
      },
    });

    queues.set(queueName, queue);
  }

  return queues.get(queueName)!;
}

// Initialize job queue system
export async function initializeJobQueue(): Promise<void> {
  console.log('Initializing job queue system with BullMQ...');

  // Initialize Redis connection
  getRedisConnection();

  // Pre-create queues for all job types
  Object.values(JobQueues).forEach((queueName) => {
    getQueue(queueName);
  });

  console.log('Job queue system initialized');
}

// Register a worker for a queue
export function registerWorker(
  queueName: string,
  processor: (job: any) => Promise<void>,
  options: { concurrency?: number } = {}
): Worker {
  if (workers.has(queueName)) {
    console.log(`Worker for ${queueName} already registered`);
    return workers.get(queueName)!;
  }

  const connection = getRedisConnection();
  const worker = new Worker(queueName, processor, {
    connection: connection as any,
    concurrency: options.concurrency || 1,
  });

  worker.on('completed', (job) => {
    console.log(`Job ${job.id} in ${queueName} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} in ${queueName} failed:`, err);
  });

  workers.set(queueName, worker);
  console.log(`Worker registered for queue: ${queueName}`);

  return worker;
}

// Add a job to a queue
export async function addJob(queueName: string, data: any): Promise<void> {
  const queue = getQueue(queueName);
  await queue.add(queueName, data);
  console.log(`Job added to ${queueName}`);
}

// Stop all queues and workers
export async function stopJobQueue(): Promise<void> {
  console.log('Stopping job queue system...');

  // Close all workers
  for (const [name, worker] of workers.entries()) {
    await worker.close();
    console.log(`Worker ${name} stopped`);
  }
  workers.clear();

  // Close all queues
  for (const [name, queue] of queues.entries()) {
    await queue.close();
    console.log(`Queue ${name} closed`);
  }
  queues.clear();

  // Close Redis connection
  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
    console.log('Redis connection closed');
  }

  console.log('Job queue system stopped');
}
