import { initializeJobs } from '../jobs/init';
import { stopJobQueue } from '../jobs/queue';

/**
 * Server setup function called when the Wasp server starts
 */
export async function serverSetup(context: any) {
  console.log('Running server setup...');

  try {
    // Initialize the job queue and register all job handlers
    await initializeJobs(context);

    console.log('Server setup completed successfully');
  } catch (error) {
    console.error('Server setup failed:', error);
    throw error;
  }
}

/**
 * Server cleanup function called when the server shuts down
 */
export async function serverCleanup() {
  console.log('Running server cleanup...');

  try {
    // Stop the job queue gracefully
    await stopJobQueue();

    console.log('Server cleanup completed successfully');
  } catch (error) {
    console.error('Server cleanup failed:', error);
  }
}

// Handle process termination signals
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  await serverCleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  await serverCleanup();
  process.exit(0);
});
