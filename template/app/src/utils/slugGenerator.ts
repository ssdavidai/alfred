import { uniqueNamesGenerator, adjectives, animals, Config } from 'unique-names-generator';

/**
 * Generate a unique slug in the format {adjective}-{animal}
 * Examples: brave-tiger, clever-dolphin, happy-penguin
 */
export function generateSlug(): string {
  const config: Config = {
    dictionaries: [adjectives, animals],
    separator: '-',
    length: 2,
    style: 'lowerCase',
  };

  return uniqueNamesGenerator(config);
}

/**
 * Check if a slug is valid (lowercase alphanumeric with hyphens)
 */
export function isValidSlug(slug: string): boolean {
  const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  return slugPattern.test(slug);
}

/**
 * Generate a unique slug and ensure it doesn't already exist in the database
 */
export async function generateUniqueSlug(
  checkExists: (slug: string) => Promise<boolean>,
  maxAttempts: number = 10
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const slug = generateSlug();
    const exists = await checkExists(slug);

    if (!exists) {
      return slug;
    }

    console.log(`Slug ${slug} already exists, trying again...`);
  }

  // If we couldn't generate a unique slug after maxAttempts, append a timestamp
  const fallbackSlug = `${generateSlug()}-${Date.now().toString(36)}`;
  console.warn(`Using fallback slug with timestamp: ${fallbackSlug}`);
  return fallbackSlug;
}
