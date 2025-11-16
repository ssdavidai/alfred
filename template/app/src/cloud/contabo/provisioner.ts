import { createContaboClient } from './client';
import { generateCloudInit } from './cloud-init-template';
import { createCloudflareClient } from '../cloudflare/dns';
import type { Environment } from 'wasp/entities';
import { prisma } from 'wasp/server';

interface ProvisionVMParams {
  environment: Environment;
  plan: string;
}

interface ProvisionVMResult {
  instanceId: string;
  ipv4?: string;
  status: string;
}

/**
 * Provision a new VM on Contabo for an environment
 */
export async function provisionVM(
  params: ProvisionVMParams,
  context: any
): Promise<ProvisionVMResult> {
  const { environment, plan } = params;

  try {
    // Get configuration from environment
    const region = process.env.CONTABO_REGION || 'US-east';
    const domain = process.env.DOMAIN_NAME || 'alfredos.site';
    const letsEncryptEmail = process.env.LETS_ENCRYPT_EMAIL || 'admin@alfredos.site';

    // Determine product ID based on plan
    // For now, we'll use a default product ID - you'll need to query Contabo API to get valid IDs
    const productId = getProductIdForPlan(plan);

    // Generate cloud-init script
    const userData = generateCloudInit({
      hostname: environment.slug,
      domain,
      letsEncryptEmail,
    });

    // Create Contabo client
    const client = createContaboClient();

    // First, let's get available images to find Ubuntu 22.04
    console.log('Fetching available images from Contabo...');
    const imagesResponse = await client.getImages();
    console.log('Available images:', JSON.stringify(imagesResponse, null, 2));

    // Find Ubuntu 22.04 image
    const ubuntu2204Image = findUbuntuImage(imagesResponse);

    // Get or create SSH key secret
    console.log('Getting or creating SSH key secret...');
    const sshPublicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBpN5rbgSQ5Y9PDP3t7jBdlgwoNbyLwkD9Gqs7wJel3G admin@alfredos.cloud';
    const sshKeySecretId = await client.getOrCreateSshKeySecret('alfredos-admin-key', sshPublicKey);
    console.log('SSH key secret ID:', sshKeySecretId);

    // Create the instance
    console.log('Creating Contabo instance...', {
      productId,
      region,
      imageId: ubuntu2204Image,
      displayName: environment.slug,
      sshKeys: [sshKeySecretId],
    });

    const createResponse = await client.createInstance({
      productId,
      region,
      imageId: ubuntu2204Image,
      displayName: environment.slug,
      userData: Buffer.from(userData).toString('base64'), // Contabo expects base64 encoded user data
      period: 1, // 1 month billing period
      sshKeys: [sshKeySecretId], // Use SSH key secret
    });

    console.log('Instance created:', createResponse);

    // Extract instance ID from response
    const instanceId = createResponse.data?.[0]?.instanceId || createResponse.instanceId;

    if (!instanceId) {
      throw new Error('Failed to get instance ID from Contabo response');
    }

    // Update environment with instance ID
    await prisma.environment.update({
      where: { id: environment.id },
      data: {
        providerInstanceId: instanceId.toString(),
        status: 'provisioning',
      },
    });

    // Poll for instance to get IP address
    let ipv4: string | undefined;
    let vmStatus = 'installing';
    let attempts = 0;
    const maxAttempts = 10;

    while (!ipv4 && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds
      attempts++;

      try {
        const instance = await client.getInstance(instanceId);
        console.log(`Instance status (attempt ${attempts}):`, instance.status);

        if (instance.ipConfig?.v4?.ip) {
          ipv4 = instance.ipConfig.v4.ip;
          console.log('Got IP address:', ipv4);
        }
      } catch (error) {
        console.error('Error polling instance:', error);
      }
    }

    // Update environment with IP if we got one
    if (ipv4) {
      await prisma.environment.update({
        where: { id: environment.id },
        data: {
          ipv4,
          status: 'provisioning', // Still provisioning until cloud-init completes
        },
      });

      // Create DNS A record pointing to the VM
      try {
        const domain = process.env.DOMAIN_NAME || 'alfredos.site';
        console.log(`Creating DNS record for ${environment.slug}.${domain} -> ${ipv4}`);
        const dnsClient = createCloudflareClient();
        await dnsClient.createARecord(environment.slug, ipv4);
        console.log(`DNS record created successfully`);
      } catch (dnsError: any) {
        console.error('Failed to create DNS record:', dnsError);
        // Don't fail the entire provisioning if DNS fails
        // The VM is still usable via IP address
      }

      // Wait for VM to be fully running
      console.log('Polling VM status until running...');
      let statusAttempts = 0;
      const maxStatusAttempts = 30; // 30 attempts * 10 seconds = 5 minutes max

      while (vmStatus !== 'running' && statusAttempts < maxStatusAttempts) {
        statusAttempts++;

        try {
          const instance = await client.getInstance(instanceId);
          vmStatus = instance.status;
          console.log(`[Attempt ${statusAttempts}/${maxStatusAttempts}] VM status: ${vmStatus}`);

          if (vmStatus === 'running') {
            // VM is fully running, update database
            await prisma.environment.update({
              where: { id: environment.id },
              data: {
                status: 'running',
              },
            });
            console.log('✅ VM is fully running! Updated status in database.');
            break; // Exit loop immediately
          }
        } catch (error) {
          console.error(`Error checking VM status (attempt ${statusAttempts}):`, error);
        }

        // Wait before next check (only if not running yet)
        if (vmStatus !== 'running' && statusAttempts < maxStatusAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
        }
      }

      if (vmStatus !== 'running') {
        console.warn(`⚠️  VM did not reach 'running' status after ${maxStatusAttempts} attempts. Last status: ${vmStatus}`);
      }
    }

    return {
      instanceId: instanceId.toString(),
      ipv4,
      status: vmStatus === 'running' ? 'running' : 'provisioning',
    };
  } catch (error: any) {
    console.error('VM provisioning failed:', error);

    // Update environment status to error
    try {
      await prisma.environment.update({
        where: { id: environment.id },
        data: {
          status: 'error',
          errorMessage: error.message || 'Unknown provisioning error',
        },
      });
    } catch (dbError) {
      console.error('Failed to update environment status:', dbError);
    }

    throw error;
  }
}

/**
 * Deprovision a VM on Contabo
 */
export async function deprovisionVM(
  environment: Environment,
  context: any
): Promise<void> {
  if (!environment.providerInstanceId) {
    throw new Error('Environment has no provider instance ID');
  }

  try {
    const client = createContaboClient();

    // Delete the instance
    await client.deleteInstance(environment.providerInstanceId);

    // Delete DNS record
    try {
      const domain = process.env.DOMAIN_NAME || 'alfredos.site';
      console.log(`Deleting DNS record for ${environment.slug}.${domain}`);
      const dnsClient = createCloudflareClient();
      await dnsClient.deleteARecord(environment.slug);
      console.log(`DNS record deleted successfully`);
    } catch (dnsError: any) {
      console.error('Failed to delete DNS record:', dnsError);
      // Don't fail deprovisioning if DNS deletion fails
    }

    // Update environment status
    await prisma.environment.update({
      where: { id: environment.id },
      data: {
        status: 'deleting',
      },
    });
  } catch (error: any) {
    console.error('VM deprovisioning failed:', error);
    throw error;
  }
}

/**
 * Get instance status from Contabo
 */
export async function getVMStatus(environment: Environment): Promise<string> {
  if (!environment.providerInstanceId) {
    throw new Error('Environment has no provider instance ID');
  }

  try {
    const client = createContaboClient();
    const status = await client.getInstanceStatus(environment.providerInstanceId);
    return status;
  } catch (error: any) {
    console.error('Failed to get VM status:', error);
    throw error;
  }
}

/**
 * Map plan name to Contabo product ID
 */
function getProductIdForPlan(plan: string): string {
  // V91 is the actual product ID from the Contabo account
  // Using V91 for all plans for now - update with different IDs when you have them
  const productMap: Record<string, string> = {
    solo: 'V91', // Contabo VPS product
    team: 'V91', // TODO: Update with actual team product ID
    enterprise: 'V91', // TODO: Update with actual enterprise product ID
  };

  return productMap[plan] || 'V91'; // Default to V91
}

/**
 * Find Ubuntu 22.04 image from Contabo images response
 */
function findUbuntuImage(imagesResponse: any): string {
  // Try to find Ubuntu 22.04 image
  const images = imagesResponse.data || [];

  const ubuntu2204 = images.find((img: any) =>
    img.name?.toLowerCase().includes('ubuntu') &&
    (img.name?.includes('22.04') || img.name?.includes('jammy'))
  );

  if (ubuntu2204) {
    return ubuntu2204.imageId;
  }

  // Fallback: try to find any Ubuntu image
  const anyUbuntu = images.find((img: any) =>
    img.name?.toLowerCase().includes('ubuntu')
  );

  if (anyUbuntu) {
    console.warn('Using fallback Ubuntu image:', anyUbuntu.name);
    return anyUbuntu.imageId;
  }

  // Last resort: use the default image from env or hardcoded
  console.warn('No Ubuntu image found, using default from environment');
  return process.env.CONTABO_DEFAULT_IMAGE || 'ubuntu-22.04';
}
