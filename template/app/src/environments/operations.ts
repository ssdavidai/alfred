import type { Environment } from 'wasp/entities';
import { HttpError } from 'wasp/server';
import { generateUniqueSlug } from '../utils/slugGenerator';
import { addJob, JobQueues } from '../jobs/queue';
import { provisionVM } from '../cloud/contabo/provisioner';

// Get all environments for the current user
export const getEnvironments = async (_args: unknown, context: any) => {
  if (!context.user) {
    throw new HttpError(401, 'User not authenticated');
  }

  return context.entities.Environment.findMany({
    where: { userId: context.user.id },
    orderBy: { createdAt: 'desc' },
    include: { usage: true },
  });
};

// Get a single environment by ID (user must own it)
export const getEnvironmentById = async ({ id }: { id: string }, context: any) => {
  if (!context.user) {
    throw new HttpError(401, 'User not authenticated');
  }

  const environment = await context.entities.Environment.findUnique({
    where: { id },
    include: { usage: true },
  });

  if (!environment) {
    throw new HttpError(404, 'Environment not found');
  }

  if (environment.userId !== context.user.id) {
    throw new HttpError(403, 'Not authorized to access this environment');
  }

  return environment;
};

// Create a new environment
export const createEnvironment = async ({ plan }: { plan: string }, context: any) => {
  if (!context.user) {
    throw new HttpError(401, 'User not authenticated');
  }

  // Check if user has active subscription
  if (context.user.subscriptionStatus !== 'active') {
    throw new HttpError(403, 'Active subscription required to create an environment');
  }

  // Generate a unique slug (e.g., "brave-tiger")
  const slug = await generateUniqueSlug(async (testSlug: string) => {
    const existing = await context.entities.Environment.findUnique({
      where: { slug: testSlug },
    });
    return !!existing;
  });

  const domain = process.env.DOMAIN_NAME || 'alfredos.site';
  const hostname = `${slug}.${domain}`;

  const environment = await context.entities.Environment.create({
    data: {
      userId: context.user.id,
      slug,
      hostname,
      plan,
      status: 'pending',
    },
    include: { usage: true },
  });

  // Queue VM provisioning job
  await addJob(JobQueues.VM_PROVISION, {
    environment,
    plan,
  });

  console.log(`VM provisioning job queued for environment ${environment.id}`);

  return environment;
};

// Delete an environment
export const deleteEnvironment = async ({ id }: { id: string }, context: any) => {
  if (!context.user) {
    throw new HttpError(401, 'User not authenticated');
  }

  const environment = await context.entities.Environment.findUnique({
    where: { id },
  });

  if (!environment) {
    throw new HttpError(404, 'Environment not found');
  }

  if (environment.userId !== context.user.id) {
    throw new HttpError(403, 'Not authorized to delete this environment');
  }

  // Update status to deleting
  const updatedEnvironment = await context.entities.Environment.update({
    where: { id },
    data: { status: 'deleting' },
    include: { usage: true },
  });

  // Queue VM deprovisioning job
  await addJob(JobQueues.VM_DEPROVISION, {
    environmentId: id,
  });

  console.log(`VM deprovisioning job queued for environment ${id}`);

  return updatedEnvironment;
};
