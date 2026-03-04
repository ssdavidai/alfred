import { HttpError } from "wasp/server";
import type { GetAdminInstances } from "wasp/server/operations";

export const getAdminInstances: GetAdminInstances<void, any> = async (
  _args,
  context,
) => {
  if (!context.user?.isAdmin) {
    throw new HttpError(403, "Admin access required");
  }

  const instances = await context.entities.Instance.findMany({
    include: {
      user: {
        select: {
          id: true,
          email: true,
          subscriptionStatus: true,
          subscriptionPlan: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return instances;
};
