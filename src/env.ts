/**
 * Load a required string from environment variables
 */
export function loadEnvString(key: string, fallback?: string): string {
  const value = process.env[key] || fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Load a required number from environment variables
 */
export function loadEnvNumber(key: string, fallback?: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') {
    if (fallback === undefined) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return fallback;
  }

  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid number for environment variable ${key}: ${raw}`);
  }

  return value;
}

/**
 * Load a comma-separated list from environment variables
 */
export function loadEnvStringList(key: string, fallback?: string[]): string[] {
  const raw = process.env[key];
  if ((raw === undefined || raw.trim() === '') && fallback) {
    return fallback;
  }
  if (raw === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
