# AlfredOS Cloud

AlfredOS Cloud is a control plane for managing development environments, built on the [Open SaaS v2](https://opensaas.sh) template.

## Tech Stack

- **Framework**: [Wasp](https://wasp.sh) - Full-stack React, Node.js, Prisma framework
- **Frontend**: React with ShadCN UI components
- **Backend**: Node.js with Prisma ORM
- **Database**: PostgreSQL
- **Authentication**: Email/password + OAuth (Google, GitHub, Discord)
- **Payments**: Stripe integration ready
- **Styling**: TailwindCSS

## Project Structure

1. `app` - Main web application built with Wasp
2. `e2e-tests` - Playwright end-to-end tests
3. `blog` - Documentation and blog built with Astro/Starlight

## Prerequisites

- Node.js (v18 or later)
- Docker Desktop (for local PostgreSQL database)
- Wasp CLI (will be installed below)

## Getting Started

### 1. Install Wasp

```bash
curl -sSL https://get.wasp.sh/installer.sh | sh
```

Add Wasp to your PATH by adding this to your shell profile (~/.zshrc or ~/.bash_profile):

```bash
export PATH=$PATH:~/.local/bin
```

### 2. Install Dependencies

Navigate to the app directory and Wasp will handle dependency installation:

```bash
cd app
```

### 3. Set Up Environment Variables

Copy the example environment files:

```bash
cd app
cp .env.server.example .env.server
cp .env.client.example .env.client
```

Edit `.env.server` to configure:
- Database connection (optional if using `wasp start db`)
- SMTP/SendGrid for emails
- Stripe for payments (optional for development)
- OAuth providers (optional)

### 4. Start the Database

Wasp provides a managed PostgreSQL database for development:

```bash
wasp start db
```

Leave this terminal running. The database will be accessible at localhost:5432.

### 5. Run Database Migrations

In a new terminal, run:

```bash
cd app
wasp db migrate-dev --name init
```

### 6. Start the Development Server

```bash
wasp start
```

This will start:
- Frontend dev server at http://localhost:3000
- Backend API server at http://localhost:3001

### 7. Access the Application

Open your browser and navigate to:
- **App**: http://localhost:3000
- **Admin Panel**: http://localhost:3000/admin (requires admin account)

## Creating Your First Admin User

1. Visit http://localhost:3000/signup
2. Create an account with the email you specified in `ADMIN_EMAILS` in `.env.server`
3. Check your terminal for the verification email link (emails are logged in development)
4. Verify your email and you'll have admin access

## Development Workflow

### Database Commands

```bash
# Start managed dev database
wasp start db

# Create a new migration
wasp db migrate-dev --name migration_name

# Reset database (WARNING: deletes all data)
wasp db reset

# Open Prisma Studio (database GUI)
wasp db studio
```

### Building for Production

```bash
wasp build
```

### Running Tests

```bash
cd e2e-tests
npm install
npm run test
```

## Project Configuration

### Main Configuration File

The Wasp configuration is in `app/main.wasp`. This file defines:
- App metadata and branding
- Database schema references
- Authentication methods
- Routes and pages
- Background jobs

### Database Schema

Database models are defined in `app/schema.prisma`. Key models include:
- User (with authentication and subscription info)
- Environment (for dev environment management)
- EnvironmentUsage (for tracking usage and billing)

## Key Features

- Email and password authentication
- OAuth integration (Google ready, others configurable)
- User management and admin dashboard
- Subscription and payment processing (Stripe)
- File upload support (AWS S3)
- Background job processing
- Analytics integration (Plausible or Google Analytics)

## Customization

### Branding

Update in `app/main.wasp`:
- App name and title
- Meta tags and SEO
- Email sender information

### Styling

TailwindCSS configuration in `app/tailwind.config.js`
UI components in `app/src/client/components/ui/`

## Deployment

Wasp supports one-command deployment to:
- Fly.io
- Railway
- Any Node.js hosting platform (manual deployment)

For production deployment guide, see: https://wasp.sh/docs/advanced/deployment/overview

## Troubleshooting

### Database Connection Issues

If you get database connection errors:
1. Ensure Docker Desktop is running
2. Check that `wasp start db` is running in a separate terminal
3. Verify no other service is using port 5432

### Build Errors

Clear the Wasp cache and rebuild:
```bash
wasp clean
wasp build
```

### Port Already in Use

If ports 3000 or 3001 are already in use:
1. Kill the process using those ports
2. Or configure different ports in Wasp configuration

## Resources

- [Open SaaS Documentation](https://docs.opensaas.sh)
- [Wasp Documentation](https://wasp.sh/docs)
- [Wasp Discord Community](https://discord.gg/aCamt5wCpS)

## License

Based on Open SaaS template (MIT License)
