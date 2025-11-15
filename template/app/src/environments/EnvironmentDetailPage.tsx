import { useParams } from 'react-router-dom';
import { Link, routes } from 'wasp/client/router';
import { useQuery, getEnvironmentById, deleteEnvironment } from 'wasp/client/operations';
import { useState } from 'react';

export default function EnvironmentDetailPage() {
  const { id } = useParams();
  const { data: environment, isLoading, refetch } = useQuery(getEnvironmentById, { id: id! });
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this environment? This action cannot be undone.')) {
      return;
    }

    setIsDeleting(true);
    try {
      await deleteEnvironment({ id: id! });
      alert('Environment is being deleted...');
      window.location.href = routes.EnvironmentsListRoute.to;
    } catch (error: any) {
      alert(`Failed to delete environment: ${error.message}`);
      setIsDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <div className='flex min-h-screen items-center justify-center'>
        <p className='text-gray-600 dark:text-gray-400'>Loading environment...</p>
      </div>
    );
  }

  if (!environment) {
    return (
      <div className='flex min-h-screen items-center justify-center'>
        <p className='text-gray-600 dark:text-gray-400'>Environment not found</p>
      </div>
    );
  }

  return (
    <div className='min-h-screen bg-gray-50 dark:bg-gray-900'>
      <div className='mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8'>
        <div className='mb-8 flex items-center justify-between'>
          <div>
            <h1 className='text-3xl font-bold text-gray-900 dark:text-white'>
              {environment.slug}
            </h1>
            <p className='mt-2 text-gray-600 dark:text-gray-400'>{environment.hostname}</p>
          </div>
          <Link
            to={routes.EnvironmentsListRoute.to}
            className='rounded-lg border-2 border-yellow-500 px-4 py-2 text-yellow-500 hover:bg-yellow-50 dark:hover:bg-gray-700'
          >
            ← Back to Environments
          </Link>
        </div>

        {/* Status Card */}
        <div className='mb-6 rounded-lg bg-white p-6 shadow dark:bg-gray-800'>
          <h2 className='mb-4 text-xl font-semibold text-gray-900 dark:text-white'>Status</h2>
          <div className='grid grid-cols-2 gap-4'>
            <div>
              <p className='text-sm text-gray-600 dark:text-gray-400'>Current Status</p>
              <span
                className={`mt-1 inline-block rounded-full px-3 py-1 text-sm font-semibold ${
                  environment.status === 'running'
                    ? 'bg-green-100 text-green-800'
                    : environment.status === 'pending'
                    ? 'bg-yellow-100 text-yellow-800'
                    : environment.status === 'provisioning'
                    ? 'bg-blue-100 text-blue-800'
                    : environment.status === 'error'
                    ? 'bg-red-100 text-red-800'
                    : 'bg-gray-100 text-gray-800'
                }`}
              >
                {environment.status}
              </span>
            </div>
            <div>
              <p className='text-sm text-gray-600 dark:text-gray-400'>Plan</p>
              <p className='mt-1 font-medium text-gray-900 dark:text-white'>
                {environment.plan}
              </p>
            </div>
          </div>
        </div>

        {/* Details Card */}
        <div className='mb-6 rounded-lg bg-white p-6 shadow dark:bg-gray-800'>
          <h2 className='mb-4 text-xl font-semibold text-gray-900 dark:text-white'>Details</h2>
          <dl className='space-y-3'>
            <div>
              <dt className='text-sm text-gray-600 dark:text-gray-400'>Hostname</dt>
              <dd className='mt-1 font-medium text-gray-900 dark:text-white'>
                {environment.hostname}
              </dd>
            </div>
            <div>
              <dt className='text-sm text-gray-600 dark:text-gray-400'>IPv4 Address</dt>
              <dd className='mt-1 font-medium text-gray-900 dark:text-white'>
                {environment.ipv4 || 'Not provisioned yet'}
              </dd>
            </div>
            <div>
              <dt className='text-sm text-gray-600 dark:text-gray-400'>Server Type</dt>
              <dd className='mt-1 font-medium text-gray-900 dark:text-white'>
                {environment.serverType}
              </dd>
            </div>
            <div>
              <dt className='text-sm text-gray-600 dark:text-gray-400'>Created</dt>
              <dd className='mt-1 font-medium text-gray-900 dark:text-white'>
                {new Date(environment.createdAt).toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className='text-sm text-gray-600 dark:text-gray-400'>Last Updated</dt>
              <dd className='mt-1 font-medium text-gray-900 dark:text-white'>
                {new Date(environment.updatedAt).toLocaleString()}
              </dd>
            </div>
          </dl>
        </div>

        {/* Actions Card */}
        <div className='mb-6 rounded-lg bg-white p-6 shadow dark:bg-gray-800'>
          <h2 className='mb-4 text-xl font-semibold text-gray-900 dark:text-white'>Actions</h2>
          <div className='flex gap-4'>
            {environment.status === 'running' && environment.ipv4 && (
              <a
                href={`https://${environment.hostname}`}
                target='_blank'
                rel='noopener noreferrer'
                className='rounded-lg bg-yellow-500 px-6 py-3 text-white hover:bg-yellow-600'
              >
                Open AlfredOS →
              </a>
            )}
            <button
              onClick={handleDelete}
              disabled={isDeleting || environment.status === 'deleting'}
              className='rounded-lg bg-red-600 px-6 py-3 text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-gray-400'
            >
              {isDeleting || environment.status === 'deleting' ? 'Deleting...' : 'Delete Environment'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
