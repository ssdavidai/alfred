# AlfredOS Cloud - Test Database Setup

## Database Connection

**Database URL:**
```
postgresql://postgresWaspDevUser:postgresWaspDevPass@localhost:5432/AlfredOSCloud-97dddb1944
```

**Docker Container:**
```bash
docker exec -it wasp-dev-db-AlfredOSCloud-97dddb1944 bash
```

**Connect via psql:**
```bash
docker exec -it wasp-dev-db-AlfredOSCloud-97dddb1944 psql -U postgresWaspDevUser -d AlfredOSCloud-97dddb1944
```

## Test Users

### Admin User 1: admin@alfredos.cloud
- **Email:** admin@alfredos.cloud
- **Status:** FULLY CONFIGURED (Password set, email verified)
- **Admin:** Yes (isAdmin = true)
- **Subscription:** Active
- **Credits:** 3
- **Auth Status:** Email verified, password set
- **Usage:** This is the primary test account - ready to use immediately

**To login:**
1. Go to http://localhost:3000/login
2. Email: admin@alfredos.cloud
3. Password: [Use existing password or reset via "Forgot Password"]

### Admin User 2: admin@alfredos.site
- **Email:** admin@alfredos.site
- **Status:** CREATED BUT NOT CONFIGURED (No password set)
- **Admin:** Yes (isAdmin = true)
- **Subscription:** Active
- **Credits:** 0
- **Auth Status:** No Auth record yet
- **Usage:** Reserved for testing signup flow

**To complete setup:**
1. Go to http://localhost:3000/signup
2. Sign up with: admin@alfredos.site
3. Set your password
4. Check server console for email verification link

## Database Statistics

- **Total Users:** 2
- **Admin Users:** 2
- **Active Subscriptions:** 2
- **Total Environments:** 0

## Seed Scripts

### Manual Seeding
Run the admin user seed script:
```bash
DATABASE_URL="postgresql://postgresWaspDevUser:postgresWaspDevPass@localhost:5432/AlfredOSCloud-97dddb1944" \
node /Users/Shared/dev/alfredos-cloud/template/app/seed-admin.mjs
```

### Wasp Seeding (when Wasp CLI is available)
```bash
# Run all seeds
wasp db seed

# Run specific seed
WASP_DB_SEED_NAME=createAdminUser wasp db seed
WASP_DB_SEED_NAME=seedMockUsers wasp db seed
```

## Database Queries

### Check User Status
```sql
SELECT
  email,
  "isAdmin",
  "subscriptionStatus",
  credits,
  "createdAt"
FROM "User"
WHERE "isAdmin" = true
ORDER BY email;
```

### Check Auth Records
```sql
SELECT
  u.email,
  u."isAdmin",
  a.id as auth_id,
  ai."providerName",
  ai."providerUserId"
FROM "User" u
LEFT JOIN "Auth" a ON u.id = a."userId"
LEFT JOIN "AuthIdentity" ai ON a.id = ai."authId"
WHERE u."isAdmin" = true
ORDER BY u.email;
```

### Check Email Verification Status
```sql
SELECT
  ai."providerUserId" as email,
  ai."providerData"::json->>'isEmailVerified' as verified
FROM "AuthIdentity" ai
WHERE ai."providerName" = 'email';
```

### Get All Environments
```sql
SELECT
  e.id,
  e.slug,
  e.hostname,
  e.status,
  e.plan,
  u.email as owner_email,
  e."createdAt"
FROM "Environment" e
JOIN "User" u ON e."userId" = u.id
ORDER BY e."createdAt" DESC;
```

## Reset Database

If you need to reset the test data:

```bash
# Drop all data from User table (cascade will delete related records)
docker exec wasp-dev-db-AlfredOSCloud-97dddb1944 psql -U postgresWaspDevUser -d AlfredOSCloud-97dddb1944 -c 'TRUNCATE TABLE "User" CASCADE;'

# Re-run seed
DATABASE_URL="postgresql://postgresWaspDevUser:postgresWaspDevPass@localhost:5432/AlfredOSCloud-97dddb1944" \
node /Users/Shared/dev/alfredos-cloud/template/app/seed-admin.mjs
```

## Testing Checklist

- [x] Admin user created in database
- [x] User has `isAdmin = true`
- [x] User has `subscriptionStatus = 'active'`
- [x] Primary test user (admin@alfredos.cloud) has password set
- [x] Primary test user email is verified
- [x] Database connection verified
- [ ] Login flow tested with admin@alfredos.cloud
- [ ] Signup flow tested with admin@alfredos.site
- [ ] Admin dashboard access verified
- [ ] Environment creation tested

## Next Steps

1. **Test Login:**
   - Navigate to http://localhost:3000/login
   - Login with admin@alfredos.cloud
   - Verify admin dashboard access

2. **Test Signup Flow (Optional):**
   - Navigate to http://localhost:3000/signup
   - Sign up with admin@alfredos.site
   - Complete email verification

3. **Test Environment Creation:**
   - Create a test environment
   - Verify database records
   - Test environment lifecycle

4. **Verify Cloud Provider Integration:**
   - Check Contabo API connectivity
   - Test VM provisioning (if credentials are valid)
   - Verify Cloudflare DNS setup
