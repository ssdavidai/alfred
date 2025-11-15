import type { PrismaClient } from '@prisma/client';

/**
 * Create an admin user for testing
 * Email: admin@alfredos.site
 *
 * NOTE: After running this seed, you'll need to sign up through the UI
 * with this email address to set a password.
 */
export async function createAdminUser(prismaClient: PrismaClient) {
  const email = 'admin@alfredos.site';

  // Check if user already exists
  const existingUser = await prismaClient.user.findUnique({
    where: { email },
  });

  if (existingUser) {
    console.log(`User ${email} already exists. Updating to admin...`);

    // Update existing user to be admin with active subscription
    await prismaClient.user.update({
      where: { email },
      data: {
        isAdmin: true,
        subscriptionStatus: 'active',
      },
    });

    console.log(`✅ Admin user updated: ${email}`);
    console.log(`   Admin: true`);
    console.log(`   Subscription: active`);
    console.log(`\n⚠️  To set/reset password, use the "Forgot Password" flow on the login page.`);
  } else {
    console.log(`Creating new admin user: ${email}`);

    // Create new user
    await prismaClient.user.create({
      data: {
        email,
        isAdmin: true,
        subscriptionStatus: 'active',
        credits: 0,
      },
    });

    console.log(`✅ Admin user created: ${email}`);
    console.log(`   Admin: true`);
    console.log(`   Subscription: active`);
    console.log(`\n⚠️  NEXT STEPS:`);
    console.log(`   1. Go to http://localhost:3000/signup`);
    console.log(`   2. Sign up with: ${email}`);
    console.log(`   3. Set your password: 123456789 (or any password)`);
    console.log(`   4. Check the server console for the email verification link`);
  }
}
