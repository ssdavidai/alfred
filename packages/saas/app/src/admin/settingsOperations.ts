import { HttpError } from "wasp/server";
import type {
  GetAdminSettings,
  UpdateAdminSetting,
  GetClosedBetaStatus,
} from "wasp/server/operations";

export const getAdminSettings: GetAdminSettings<
  void,
  Record<string, string>
> = async (_args, context) => {
  if (!context.user?.isAdmin) {
    throw new HttpError(403, "Admin access required");
  }
  const settings = await context.entities.AdminSetting.findMany();
  const map: Record<string, string> = {};
  for (const s of settings) {
    map[s.key] = s.value;
  }
  return map;
};

export const updateAdminSetting: UpdateAdminSetting<
  { key: string; value: string },
  { key: string; value: string; updatedAt: Date }
> = async (args, context) => {
  if (!context.user?.isAdmin) {
    throw new HttpError(403, "Admin access required");
  }
  return context.entities.AdminSetting.upsert({
    where: { key: args.key },
    update: { value: args.value },
    create: { key: args.key, value: args.value },
  });
};

export const getClosedBetaStatus: GetClosedBetaStatus<
  void,
  boolean
> = async (_args, context) => {
  const setting = await context.entities.AdminSetting.findUnique({
    where: { key: "closed_beta" },
  });
  return setting?.value === "true";
};
