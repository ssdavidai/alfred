/**
 * Standalone seed script to create admin user
 * Run this with: node seed-admin.mjs
 */

import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';

// Load environment variables
config({ path: '.env.server' });

const prisma = new PrismaClient();

async function createAdminUser() {
  const email = 'admin@alfredos.site';

  try {
    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      console.log(`User ${email} already exists. Updating to admin...`);

      // Update existing user to be admin with active subscription
      await prisma.user.update({
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
      await prisma.user.create({
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
  } catch (error) {
    console.error('Error creating admin user:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the seed
createAdminUser()
  .then(() => {
    console.log('\n✅ Seed completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Seed failed:', error);
    process.exit(1);
  });
