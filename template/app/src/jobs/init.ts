import { initializeJobQueue, registerWorker, JobQueues } from './queue';
import { provisionVM, deprovisionVM } from '../cloud/contabo/provisioner';
import { type Environment } from 'wasp/entities';
import { prisma } from 'wasp/server';

export async function initializeJobs(context: any) {
  // Initialize the job queue system
  await initializeJobQueue();

  // Register VM provisioning worker
  registerWorker(
    JobQueues.VM_PROVISION,
    async (job: any) => {
      const { environment, plan } = job.data;

      console.log(`Processing VM provision job for environment: ${environment.id}`);

      try {
        await provisionVM({ environment, plan }, context);
        console.log(`VM provisioning completed for environment: ${environment.id}`);
      } catch (error) {
        console.error(`VM provisioning failed for environment ${environment.id}:`, error);

        // Update environment status to error
        try {
          await prisma.environment.update({
            where: { id: environment.id },
            data: {
              status: 'error',
              errorMessage: error instanceof Error ? error.message : 'VM provisioning failed',
            },
          });
        } catch (dbError) {
          console.error('Failed to update environment status:', dbError);
        }

        throw error; // Re-throw to mark job as failed
      }
    },
    { concurrency: 1 }
  );

  // Register VM deprovisioning worker
  registerWorker(
    JobQueues.VM_DEPROVISION,
    async (job: any) => {
      const { environmentId } = job.data;

      console.log(`Processing VM deprovision job for environment: ${environmentId}`);

      try {
        // Get environment details before deletion
        const environment = await prisma.environment.findUnique({
          where: { id: environmentId },
        });

        if (!environment) {
          console.warn(`Environment ${environmentId} not found, skipping deprovisioning`);
          return;
        }

        // Actually deprovision the VM from Contabo and delete DNS records
        if (environment.providerInstanceId) {
          console.log(`Deprovisioning VM for environment: ${environmentId}`);
          await deprovisionVM(environment, context);
        } else {
          console.log(`No VM instance found for environment ${environmentId}, skipping VM deletion`);
        }

        // Delete environment from database
        await prisma.environment.delete({
          where: { id: environmentId },
        });

        console.log(`VM deprovisioning completed for environment: ${environmentId}`);
      } catch (error) {
        console.error(`VM deprovisioning failed for environment ${environmentId}:`, error);
        throw error;
      }
    },
    { concurrency: 1 }
  );

  console.log('Job handlers registered');
}
