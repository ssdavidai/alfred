import { useAuth } from 'wasp/client/auth';
import { Link, routes } from 'wasp/client/router';
import { Link as RouterLink } from 'react-router-dom';
import { createEnvironment, useQuery, getEnvironments } from 'wasp/client/operations';
import { useState } from 'react';

export default function DashboardPage() {
  const { data: user } = useAuth();
  const { data: environments, isLoading, refetch } = useQuery(getEnvironments);
  const [isCreating, setIsCreating] = useState(false);

  const handleCreateEnvironment = async () => {
    if (!user?.subscriptionStatus || user.subscriptionStatus !== 'active') {
      alert('You need an active subscription to create an environment. Please subscribe first.');
      return;
    }

    setIsCreating(true);
    try {
      await createEnvironment({ plan: 'solo' });
      await refetch();
      alert('Environment created! It will be provisioned shortly.');
    } catch (error: any) {
      alert(`Failed to create environment: ${error.message}`);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className='min-h-screen bg-gray-50 dark:bg-gray-900'>
      <div className='mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8'>
        <div className='mb-8'>
          <h1 className='text-3xl font-bold text-gray-900 dark:text-white'>
            Welcome to AlfredOS Cloud
          </h1>
          <p className='mt-2 text-gray-600 dark:text-gray-400'>
            Manage your AI-powered cloud environments
          </p>
        </div>

        {/* Subscription Status Card */}
        <div className='mb-6 rounded-lg bg-white p-6 shadow dark:bg-gray-800'>
          <h2 className='mb-4 text-xl font-semibold text-gray-900 dark:text-white'>
            Subscription Status
          </h2>
          <div className='flex items-center justify-between'>
            <div>
              <p className='text-sm text-gray-600 dark:text-gray-400'>Current Plan</p>
              <p className='text-lg font-medium text-gray-900 dark:text-white'>
                {user?.subscriptionPlan || 'No subscription'}
              </p>
              <p className='text-sm text-gray-600 dark:text-gray-400'>
                Status:{' '}
                <span
                  className={
                    user?.subscriptionStatus === 'active'
                      ? 'text-green-600'
                      : 'text-red-600'
                  }
                >
                  {user?.subscriptionStatus || 'Inactive'}
                </span>
              </p>
            </div>
            {user?.subscriptionStatus !== 'active' && (
              <Link
                to={routes.PricingPageRoute.to}
                className='rounded-lg bg-yellow-500 px-4 py-2 text-white hover:bg-yellow-600'
              >
                Subscribe Now
              </Link>
            )}
          </div>
        </div>

        {/* Quick Actions Card */}
        <div className='mb-6 rounded-lg bg-white p-6 shadow dark:bg-gray-800'>
          <h2 className='mb-4 text-xl font-semibold text-gray-900 dark:text-white'>
            Quick Actions
          </h2>
          <div className='flex gap-4'>
            <button
              onClick={handleCreateEnvironment}
              disabled={isCreating || user?.subscriptionStatus !== 'active'}
              className='rounded-lg bg-yellow-500 px-6 py-3 font-semibold text-white hover:bg-yellow-600 disabled:cursor-not-allowed disabled:bg-gray-400'
            >
              {isCreating ? 'Creating...' : 'Launch My AlfredOS'}
            </button>
            <Link
              to={routes.EnvironmentsListRoute.to}
              className='rounded-lg border-2 border-yellow-500 px-6 py-3 font-semibold text-yellow-500 hover:bg-yellow-50 dark:hover:bg-gray-700'
            >
              View All Environments
            </Link>
          </div>
        </div>

        {/* Environments Overview */}
        <div className='rounded-lg bg-white p-6 shadow dark:bg-gray-800'>
          <h2 className='mb-4 text-xl font-semibold text-gray-900 dark:text-white'>
            Your Environments
          </h2>
          {isLoading ? (
            <p className='text-gray-600 dark:text-gray-400'>Loading...</p>
          ) : environments && environments.length > 0 ? (
            <div className='space-y-2'>
              {environments.slice(0, 3).map((env: any) => (
                <RouterLink
                  key={env.id}
                  to={`/environments/${env.id}`}
                  className='block rounded border p-4 hover:bg-gray-50 dark:hover:bg-gray-700'
                >
                  <div className='flex items-center justify-between'>
                    <div>
                      <p className='font-medium text-gray-900 dark:text-white'>{env.slug}</p>
                      <p className='text-sm text-gray-600 dark:text-gray-400'>
                        {env.hostname}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-3 py-1 text-sm ${
                        env.status === 'running'
                          ? 'bg-green-100 text-green-800'
                          : env.status === 'pending'
                          ? 'bg-yellow-100 text-yellow-800'
                          : env.status === 'error'
                          ? 'bg-red-100 text-red-800'
                          : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {env.status}
                    </span>
                  </div>
                </RouterLink>
              ))}
              {environments.length > 3 && (
                <Link
                  to={routes.EnvironmentsListRoute.to}
                  className='block pt-2 text-center text-yellow-500 hover:underline'
                >
                  View all {environments.length} environments →
                </Link>
              )}
            </div>
          ) : (
            <p className='text-gray-600 dark:text-gray-400'>
              No environments yet. Click "Launch My AlfredOS" to get started!
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
