import { Link, routes } from 'wasp/client/router';
import { Link as RouterLink } from 'react-router-dom';
import { useQuery, getEnvironments } from 'wasp/client/operations';

export default function EnvironmentsListPage() {
  const { data: environments, isLoading } = useQuery(getEnvironments);

  if (isLoading) {
    return (
      <div className='flex min-h-screen items-center justify-center'>
        <p className='text-gray-600 dark:text-gray-400'>Loading environments...</p>
      </div>
    );
  }

  return (
    <div className='min-h-screen bg-gray-50 dark:bg-gray-900'>
      <div className='mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8'>
        <div className='mb-8 flex items-center justify-between'>
          <div>
            <h1 className='text-3xl font-bold text-gray-900 dark:text-white'>
              Your Environments
            </h1>
            <p className='mt-2 text-gray-600 dark:text-gray-400'>
              Manage all your AlfredOS cloud environments
            </p>
          </div>
          <Link
            to={routes.DashboardRoute.to}
            className='rounded-lg bg-yellow-500 px-4 py-2 text-white hover:bg-yellow-600'
          >
            ← Back to Dashboard
          </Link>
        </div>

        {environments && environments.length > 0 ? (
          <div className='overflow-hidden rounded-lg bg-white shadow dark:bg-gray-800'>
            <table className='min-w-full divide-y divide-gray-200 dark:divide-gray-700'>
              <thead className='bg-gray-50 dark:bg-gray-700'>
                <tr>
                  <th className='px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300'>
                    Slug
                  </th>
                  <th className='px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300'>
                    Hostname
                  </th>
                  <th className='px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300'>
                    Status
                  </th>
                  <th className='px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300'>
                    Plan
                  </th>
                  <th className='px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300'>
                    Created
                  </th>
                  <th className='px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300'>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className='divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-800'>
                {environments.map((env: any) => (
                  <tr key={env.id} className='hover:bg-gray-50 dark:hover:bg-gray-700'>
                    <td className='whitespace-nowrap px-6 py-4'>
                      <div className='font-medium text-gray-900 dark:text-white'>{env.slug}</div>
                    </td>
                    <td className='whitespace-nowrap px-6 py-4'>
                      <div className='text-gray-600 dark:text-gray-400'>{env.hostname}</div>
                    </td>
                    <td className='whitespace-nowrap px-6 py-4'>
                      <span
                        className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                          env.status === 'running'
                            ? 'bg-green-100 text-green-800'
                            : env.status === 'pending'
                            ? 'bg-yellow-100 text-yellow-800'
                            : env.status === 'provisioning'
                            ? 'bg-blue-100 text-blue-800'
                            : env.status === 'error'
                            ? 'bg-red-100 text-red-800'
                            : 'bg-gray-100 text-gray-800'
                        }`}
                      >
                        {env.status}
                      </span>
                    </td>
                    <td className='whitespace-nowrap px-6 py-4 text-sm text-gray-600 dark:text-gray-400'>
                      {env.plan}
                    </td>
                    <td className='whitespace-nowrap px-6 py-4 text-sm text-gray-600 dark:text-gray-400'>
                      {new Date(env.createdAt).toLocaleDateString()}
                    </td>
                    <td className='whitespace-nowrap px-6 py-4 text-right text-sm font-medium'>
                      <RouterLink
                        to={`/environments/${env.id}`}
                        className='text-yellow-600 hover:text-yellow-900 dark:hover:text-yellow-400'
                      >
                        View Details →
                      </RouterLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className='rounded-lg bg-white p-12 text-center shadow dark:bg-gray-800'>
            <p className='mb-4 text-gray-600 dark:text-gray-400'>
              You don't have any environments yet.
            </p>
            <Link
              to={routes.DashboardRoute.to}
              className='inline-block rounded-lg bg-yellow-500 px-6 py-3 text-white hover:bg-yellow-600'
            >
              Go to Dashboard
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
