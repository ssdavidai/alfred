import { type Prisma } from "@prisma/client";
import { type User } from "wasp/entities";
import { HttpError, prisma } from "wasp/server";
import {
  type AdminUpdateUser,
  type DeleteUserById,
  type GetPaginatedUsers,
  type UpdateIsUserAdminById,
} from "wasp/server/operations";
import * as z from "zod";
import { SubscriptionStatus } from "../payment/plans";
import { ensureArgsSchemaOrThrowHttpError } from "../server/validation";

const updateUserAdminByIdInputSchema = z.object({
  id: z.string().nonempty(),
  isAdmin: z.boolean(),
});

type UpdateUserAdminByIdInput = z.infer<typeof updateUserAdminByIdInputSchema>;

export const updateIsUserAdminById: UpdateIsUserAdminById<
  UpdateUserAdminByIdInput,
  User
> = async (rawArgs, context) => {
  const { id, isAdmin } = ensureArgsSchemaOrThrowHttpError(
    updateUserAdminByIdInputSchema,
    rawArgs,
  );

  if (!context.user) {
    throw new HttpError(
      401,
      "Only authenticated users are allowed to perform this operation",
    );
  }

  if (!context.user.isAdmin) {
    throw new HttpError(
      403,
      "Only admins are allowed to perform this operation",
    );
  }

  return context.entities.User.update({
    where: { id },
    data: { isAdmin },
  });
};

type GetPaginatedUsersOutput = {
  users: (Pick<
    User,
    | "id"
    | "email"
    | "username"
    | "subscriptionStatus"
    | "subscriptionPlan"
    | "paymentProcessorUserId"
    | "isAdmin"
  > & { instance: { id: string; status: string } | null })[];
  totalPages: number;
};

const getPaginatorArgsSchema = z.object({
  skipPages: z.number(),
  filter: z.object({
    emailContains: z.string().nonempty().optional(),
    isAdmin: z.boolean().optional(),
    subscriptionStatusIn: z
      .array(z.nativeEnum(SubscriptionStatus).nullable())
      .optional(),
  }),
});

type GetPaginatedUsersInput = z.infer<typeof getPaginatorArgsSchema>;

export const getPaginatedUsers: GetPaginatedUsers<
  GetPaginatedUsersInput,
  GetPaginatedUsersOutput
> = async (rawArgs, context) => {
  if (!context.user) {
    throw new HttpError(
      401,
      "Only authenticated users are allowed to perform this operation",
    );
  }

  if (!context.user.isAdmin) {
    throw new HttpError(
      403,
      "Only admins are allowed to perform this operation",
    );
  }

  const {
    skipPages,
    filter: {
      subscriptionStatusIn: subscriptionStatus,
      emailContains,
      isAdmin,
    },
  } = ensureArgsSchemaOrThrowHttpError(getPaginatorArgsSchema, rawArgs);

  const includeUnsubscribedUsers = !!subscriptionStatus?.some(
    (status) => status === null,
  );
  const desiredSubscriptionStatuses = subscriptionStatus?.filter(
    (status) => status !== null,
  );

  const pageSize = 10;

  const where: Prisma.UserWhereInput = {
    AND: [
      {
        email: {
          contains: emailContains,
          mode: "insensitive",
        },
        isAdmin,
      },
      {
        OR: [
          {
            subscriptionStatus: {
              in: desiredSubscriptionStatuses,
            },
          },
          {
            subscriptionStatus: includeUnsubscribedUsers ? null : undefined,
          },
        ],
      },
    ],
  };

  const [pageOfUsers, totalUsers] = await prisma.$transaction([
    context.entities.User.findMany({
      skip: skipPages * pageSize,
      take: pageSize,
      where,
      select: {
        id: true,
        email: true,
        username: true,
        isAdmin: true,
        subscriptionStatus: true,
        subscriptionPlan: true,
        paymentProcessorUserId: true,
        instance: { select: { id: true, status: true } },
      },
      orderBy: { username: "asc" },
    }),
    context.entities.User.count({ where }),
  ]);
  const totalPages = Math.ceil(totalUsers / pageSize);

  return {
    users: pageOfUsers,
    totalPages,
  };
};

const deleteUserByIdInputSchema = z.object({
  id: z.string().nonempty(),
});

type DeleteUserByIdInput = z.infer<typeof deleteUserByIdInputSchema>;

export const deleteUserById: DeleteUserById<DeleteUserByIdInput, void> = async (
  rawArgs,
  context,
) => {
  const { id } = ensureArgsSchemaOrThrowHttpError(
    deleteUserByIdInputSchema,
    rawArgs,
  );

  if (!context.user) {
    throw new HttpError(
      401,
      "Only authenticated users are allowed to perform this operation",
    );
  }

  if (!context.user.isAdmin) {
    throw new HttpError(
      403,
      "Only admins are allowed to perform this operation",
    );
  }

  if (context.user.id === id) {
    throw new HttpError(400, "You cannot delete your own account");
  }

  // Delete related records in FK order, then the user.
  // Every table with a userId or authId FK must be cleared here.

  // First: delete Auth children (AuthIdentity + Session reference auth.id, not user.id)
  const auth = await prisma.auth.findFirst({ where: { userId: id } });
  if (auth) {
    await prisma.$transaction([
      prisma.authIdentity.deleteMany({ where: { authId: auth.id } }),
      prisma.session.deleteMany({ where: { userId: auth.id } }),
    ]);
  }

  // Then: delete all user-owned records + auth + user
  await prisma.$transaction([
    prisma.streamEvent.deleteMany({ where: { userId: id } }),
    prisma.stream.deleteMany({ where: { userId: id } }),
    prisma.oAuthCredential.deleteMany({ where: { userId: id } }),
    context.entities.ApiKey.deleteMany({ where: { userId: id } }),
    context.entities.ContactFormMessage.deleteMany({ where: { userId: id } }),
    context.entities.ProvisioningJob.deleteMany({ where: { userId: id } }),
    context.entities.Instance.deleteMany({ where: { userId: id } }),
    prisma.auth.deleteMany({ where: { userId: id } }),
    context.entities.User.delete({ where: { id } }),
  ]);
};

// ============================================================
// Admin: Update User
// ============================================================

const adminUpdateUserSchema = z.object({
  id: z.string().nonempty(),
  email: z.string().email().optional(),
  username: z.string().optional(),
  subscriptionPlan: z.string().nullable().optional(),
  subscriptionStatus: z.string().nullable().optional(),
});

type AdminUpdateUserInput = z.infer<typeof adminUpdateUserSchema>;

export const adminUpdateUser: AdminUpdateUser<AdminUpdateUserInput, User> =
  async (rawArgs, context) => {
    const args = ensureArgsSchemaOrThrowHttpError(
      adminUpdateUserSchema,
      rawArgs,
    );

    if (!context.user?.isAdmin) {
      throw new HttpError(403, "Admin access required");
    }

    const { id, ...fields } = args;

    // Build update data from provided fields only
    const data: Record<string, unknown> = {};
    if (fields.email !== undefined) data.email = fields.email;
    if (fields.username !== undefined) data.username = fields.username;
    if (fields.subscriptionPlan !== undefined)
      data.subscriptionPlan = fields.subscriptionPlan;
    if (fields.subscriptionStatus !== undefined)
      data.subscriptionStatus = fields.subscriptionStatus;

    if (Object.keys(data).length === 0) {
      throw new HttpError(400, "No fields to update");
    }

    return context.entities.User.update({
      where: { id },
      data,
    });
  };
