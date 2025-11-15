import { type AuthUser } from 'wasp/auth';
import { useQuery, getPaginatedEnvironments, getEnvironmentStats } from 'wasp/client/operations';
import { useState } from 'react';
import Breadcrumb from '../../layout/Breadcrumb';
import DefaultLayout from '../../layout/DefaultLayout';

const EnvironmentsDashboard = ({ user }: { user: AuthUser }) => {
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 10;

  const { data: stats } = useQuery(getEnvironmentStats);
  const { data: paginatedData, isLoading } = useQuery(getPaginatedEnvironments, {
    skip: page * pageSize,
    take: pageSize,
    statusFilter,
    searchQuery,
  });

  const environments = paginatedData?.environments || [];
  const totalCount = paginatedData?.totalCount || 0;
  const totalPages = Math.ceil(totalCount / pageSize);

  return (
    <DefaultLayout user={user}>
      <Breadcrumb pageName='Environments' />
      <div className='flex flex-col gap-6'>

        {/* Stats Cards */}
        {stats && (
          <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4'>
            <div className='rounded-lg bg-white p-6 shadow dark:bg-gray-800'>
              <p className='text-sm text-gray-600 dark:text-gray-400'>Total Environments</p>
              <p className='mt-2 text-3xl font-bold text-gray-900 dark:text-white'>
                {stats.total}
              </p>
            </div>
            <div className='rounded-lg bg-white p-6 shadow dark:bg-gray-800'>
              <p className='text-sm text-gray-600 dark:text-gray-400'>Running</p>
              <p className='mt-2 text-3xl font-bold text-green-600'>{stats.running}</p>
            </div>
            <div className='rounded-lg bg-white p-6 shadow dark:bg-gray-800'>
              <p className='text-sm text-gray-600 dark:text-gray-400'>Stopped</p>
              <p className='mt-2 text-3xl font-bold text-gray-600 dark:text-gray-400'>
                {stats.stopped}
              </p>
            </div>
            <div className='rounded-lg bg-white p-6 shadow dark:bg-gray-800'>
              <p className='text-sm text-gray-600 dark:text-gray-400'>Errors</p>
              <p className='mt-2 text-3xl font-bold text-red-600'>{stats.error}</p>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className='flex gap-4 rounded-lg bg-white p-4 shadow dark:bg-gray-800'>
          <div className='flex-1'>
            <input
              type='text'
              placeholder='Search by slug, hostname, or tenant ID...'
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(0);
              }}
              className='w-full rounded-lg border border-gray-300 px-4 py-2 dark:border-gray-600 dark:bg-gray-700 dark:text-white'
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(0);
            }}
            className='rounded-lg border border-gray-300 px-4 py-2 dark:border-gray-600 dark:bg-gray-700 dark:text-white'
          >
            <option value='all'>All Statuses</option>
            <option value='pending'>Pending</option>
            <option value='provisioning'>Provisioning</option>
            <option value='running'>Running</option>
            <option value='stopped'>Stopped</option>
            <option value='error'>Error</option>
            <option value='deleting'>Deleting</option>
          </select>
        </div>

        {/* Environments Table */}
        {isLoading ? (
          <div className='flex justify-center py-12'>
            <p className='text-gray-600 dark:text-gray-400'>Loading environments...</p>
          </div>
        ) : environments.length > 0 ? (
          <>
            <div className='overflow-hidden rounded-lg bg-white shadow dark:bg-gray-800'>
              <table className='min-w-full divide-y divide-gray-200 dark:divide-gray-700'>
                <thead className='bg-gray-50 dark:bg-gray-700'>
                  <tr>
                    <th className='px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300'>
                      Slug
                    </th>
                    <th className='px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300'>
                      Tenant
                    </th>
                    <th className='px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300'>
                      Status
                    </th>
                    <th className='px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300'>
                      IPv4
                    </th>
                    <th className='px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300'>
                      Created
                    </th>
                  </tr>
                </thead>
                <tbody className='divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-800'>
                  {environments.map((env: any) => (
                    <tr key={env.id} className='hover:bg-gray-50 dark:hover:bg-gray-700'>
                      <td className='whitespace-nowrap px-6 py-4'>
                        <div className='font-medium text-gray-900 dark:text-white'>{env.slug}</div>
                        <div className='text-sm text-gray-600 dark:text-gray-400'>{env.hostname}</div>
                      </td>
                      <td className='whitespace-nowrap px-6 py-4'>
                        <div className='text-sm text-gray-900 dark:text-white'>{env.user?.email || 'N/A'}</div>
                        <div className='text-xs text-gray-600 dark:text-gray-400'>{env.userId}</div>
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
                        {env.ipv4 || 'N/A'}
                      </td>
                      <td className='whitespace-nowrap px-6 py-4 text-sm text-gray-600 dark:text-gray-400'>
                        {new Date(env.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className='mt-4 flex justify-center gap-2'>
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className='rounded-lg bg-white px-4 py-2 shadow hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-800 dark:hover:bg-gray-700'
                >
                  Previous
                </button>
                <span className='flex items-center px-4 text-gray-700 dark:text-gray-300'>
                  Page {page + 1} of {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className='rounded-lg bg-white px-4 py-2 shadow hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-800 dark:hover:bg-gray-700'
                >
                  Next
                </button>
              </div>
            )}
          </>
        ) : (
          <div className='rounded-lg bg-white p-12 text-center shadow dark:bg-gray-800'>
            <p className='text-gray-600 dark:text-gray-400'>No environments found</p>
          </div>
        )}
      </div>
    </DefaultLayout>
  );
};

export default EnvironmentsDashboard;
