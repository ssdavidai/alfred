# Quick Test Guide - AlfredOS Cloud

## Ready-to-Use Test Account

**Email:** admin@alfredos.cloud
**Password:** [Already set - use existing or reset]
**Login URL:** http://localhost:3000/login
**Admin Status:** ✅ Yes
**Subscription:** ✅ Active
**Email Verified:** ✅ Yes

## Quick Commands

### Run Admin Seed
```bash
DATABASE_URL="postgresql://postgresWaspDevUser:postgresWaspDevPass@localhost:5432/AlfredOSCloud-97dddb1944" \
node seed-admin.mjs
```

### Connect to Database
```bash
docker exec -it wasp-dev-db-AlfredOSCloud-97dddb1944 psql -U postgresWaspDevUser -d AlfredOSCloud-97dddb1944
```

### Verify Admin User
```bash
docker exec wasp-dev-db-AlfredOSCloud-97dddb1944 psql -U postgresWaspDevUser -d AlfredOSCloud-97dddb1944 -c \
"SELECT email, \"isAdmin\", \"subscriptionStatus\", credits FROM \"User\" WHERE \"isAdmin\" = true;"
```

### Check Database Stats
```bash
docker exec wasp-dev-db-AlfredOSCloud-97dddb1944 psql -U postgresWaspDevUser -d AlfredOSCloud-97dddb1944 -c \
"SELECT
  COUNT(*) as total_users,
  COUNT(CASE WHEN \"isAdmin\" = true THEN 1 END) as admin_users,
  COUNT(CASE WHEN \"subscriptionStatus\" = 'active' THEN 1 END) as active_subs
FROM \"User\";"
```

## Test Scenarios

1. **Login Test** → Use admin@alfredos.cloud
2. **Signup Test** → Use admin@alfredos.site (not configured yet)
3. **Admin Dashboard** → Should be accessible after login
4. **Environment Creation** → Test cloud provisioning

## Files Created

- `seed-admin.mjs` - Standalone seed script
- `TEST_DATABASE_INFO.md` - Detailed database documentation
- `QUICK_TEST_GUIDE.md` - This file
