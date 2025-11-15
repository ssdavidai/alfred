# Contabo API Credentials Setup Guide

## Current Status
**Authentication Failed: Invalid user credentials**

The credentials in `.env.server` appear to be test/invalid credentials.

## How to Get Valid Contabo API Credentials

### 1. Access the Contabo Customer Control Panel
- Log in to your Contabo account at https://my.contabo.com

### 2. Navigate to Account Settings
- Go to **Account** → **Security & Access** → **API Credentials**
- Or look for the **Account Secret** menu item

### 3. Generate/Retrieve API Credentials

You need four pieces of information:

#### a) OAuth2 Client ID
- Format: `INT-XXXXXXXX` (e.g., `INT-14380020`)
- Found in the Customer Control Panel under "Account Secret"

#### b) OAuth2 Client Secret
- A long alphanumeric string
- Found in the Customer Control Panel under "Account Secret"
- **Keep this secret!**

#### c) API User
- Your API username (may be your email or a separate API user)
- Found/created in the Customer Control Panel

#### d) API Password
- **Important:** This is NOT your regular Contabo login password
- This is a separate password you create specifically for API access
- You can set or change this in the Customer Control Panel under "Account Secret"

### 4. Update `.env.server`

Once you have valid credentials, update these values in `.env.server`:

```bash
CONTABO_CLIENT_ID=INT-XXXXXXXX
CONTABO_CLIENT_SECRET=your-client-secret-here
CONTABO_API_USER=your-api-user-here
CONTABO_API_PASSWORD=your-api-password-here
CONTABO_REGION=US-east
```

### 5. Verify Region

Valid Contabo regions (as of 2024):
- `EU` - European Union
- `US-central` - United States Central
- `US-east` - United States East
- `US-west` - United States West
- `SIN` - Singapore
- `UK` - United Kingdom
- `AUS` - Australia
- `JPN` - Japan

## Testing the API

After updating credentials, run:

```bash
npx tsx src/cloud/contabo/test-contabo-api.ts
```

## Authentication Endpoint

The API uses OAuth 2.0 password grant type:

```
POST https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token
```

Parameters:
- `client_id`: Your OAuth2 Client ID
- `client_secret`: Your OAuth2 Client Secret
- `username`: Your API User
- `password`: Your API Password (NOT your login password)
- `grant_type`: `password`

## Common Issues

### "Invalid user credentials" Error

This means one or more of your credentials are incorrect:

1. **Check API Password**: Most common issue - make sure you're using the API password, not your login password
2. **Verify API User**: Ensure the API user is correctly set up in your account
3. **Check Client ID/Secret**: Make sure they match what's shown in your account
4. **Account Status**: Ensure your Contabo account is active and in good standing

### "Invalid client" Error

This means the Client ID or Client Secret is incorrect.

## Need Help?

- Contabo API Documentation: https://api.contabo.com/
- Contabo Support: https://contabo.com/en/support/
- API Help Article: https://help.contabo.com/en/support/solutions/articles/103000270527
