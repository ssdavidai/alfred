import { HttpError } from 'wasp/server';

type PaginatedEnvironmentsArgs = {
  skip?: number;
  take?: number;
  statusFilter?: string;
  searchQuery?: string;
};

type PaginatedEnvironmentsResult = {
  environments: any[];
  totalCount: number;
};

type EnvironmentStatsResult = {
  total: number;
  running: number;
  stopped: number;
  error: number;
};

// Get paginated environments with filtering (admin only)
export const getPaginatedEnvironments = async (args: PaginatedEnvironmentsArgs, context: any): Promise<PaginatedEnvironmentsResult> => {
  if (!context.user) {
    throw new HttpError(401, 'User not authenticated');
  }

  if (!context.user.isAdmin) {
    throw new HttpError(403, 'Admin access required');
  }

  const { skip = 0, take = 10, statusFilter, searchQuery } = args;

  const where: any = {};

  if (statusFilter && statusFilter !== 'all') {
    where.status = statusFilter;
  }

  if (searchQuery) {
    where.OR = [
      { slug: { contains: searchQuery, mode: 'insensitive' as any } },
      { hostname: { contains: searchQuery, mode: 'insensitive' as any } },
      { userId: { contains: searchQuery, mode: 'insensitive' as any } },
    ];
  }

  const [environments, totalCount] = await Promise.all([
    context.entities.Environment.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            username: true,
          },
        },
        usage: true,
      },
    }),
    context.entities.Environment.count({ where }),
  ]);

  return { environments, totalCount };
};

// Get environment statistics (admin only)
export const getEnvironmentStats = async (_args: unknown, context: any): Promise<EnvironmentStatsResult> => {
  if (!context.user) {
    throw new HttpError(401, 'User not authenticated');
  }

  if (!context.user.isAdmin) {
    throw new HttpError(403, 'Admin access required');
  }

  const [total, running, stopped, error] = await Promise.all([
    context.entities.Environment.count(),
    context.entities.Environment.count({ where: { status: 'running' } }),
    context.entities.Environment.count({ where: { status: 'stopped' } }),
    context.entities.Environment.count({ where: { status: 'error' } }),
  ]);

  return { total, running, stopped, error };
};
