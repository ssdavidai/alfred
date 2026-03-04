import { HttpError } from "wasp/server";
import type {
  ListApiKeys,
  CreateApiKey,
  RevokeApiKey,
} from "wasp/server/operations";
import crypto from "crypto";

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function generateApiKey(): string {
  // Format: alf_<32 random hex chars> = 36 char key
  const random = crypto.randomBytes(16).toString("hex");
  return `alf_${random}`;
}

type ApiKeyListItem = {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: Date | null;
  createdAt: Date;
};

export const listApiKeys: ListApiKeys<void, ApiKeyListItem[]> = async (
  _args,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401, "Not authenticated");
  }

  return context.entities.ApiKey.findMany({
    where: { userId: context.user.id },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      lastUsedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
};

type CreateApiKeyInput = { name: string };
type CreateApiKeyResult = { id: string; key: string };

export const createApiKey: CreateApiKey<
  CreateApiKeyInput,
  CreateApiKeyResult
> = async (args, context) => {
  if (!context.user) {
    throw new HttpError(401, "Not authenticated");
  }

  const name = args.name?.trim();
  if (!name) {
    throw new HttpError(400, "API key name is required");
  }

  // Limit to 10 keys per user
  const count = await context.entities.ApiKey.count({
    where: { userId: context.user.id },
  });
  if (count >= 10) {
    throw new HttpError(400, "Maximum of 10 API keys allowed");
  }

  const key = generateApiKey();
  const keyHash = hashKey(key);
  const keyPrefix = key.slice(0, 12); // "alf_a1b2c3d4"

  const record = await context.entities.ApiKey.create({
    data: {
      userId: context.user.id,
      name,
      keyHash,
      keyPrefix,
    },
  });

  // Return the full key only once — it won't be stored or retrievable
  return { id: record.id, key };
};

export const revokeApiKey: RevokeApiKey<{ id: string }, void> = async (
  args,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401, "Not authenticated");
  }

  const apiKey = await context.entities.ApiKey.findUnique({
    where: { id: args.id },
  });

  if (!apiKey || apiKey.userId !== context.user.id) {
    throw new HttpError(404, "API key not found");
  }

  await context.entities.ApiKey.delete({ where: { id: args.id } });
};
