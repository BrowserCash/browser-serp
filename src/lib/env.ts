export function loadEnvString(key: string, fallback?: string): string {
  const v = process.env[key] || fallback
  if (v === undefined) throw new Error(`Missing env: ${key}`)
  return v
}

export function loadEnvNumber(key: string, fallback?: number): number {
  const raw = process.env[key]
  if (raw === undefined || raw === '') {
    if (fallback === undefined) throw new Error(`Missing env: ${key}`)
    return fallback
  }
  const n = Number(raw)
  if (Number.isNaN(n)) throw new Error(`Env ${key} must be a number`)
  return n
}

export function loadEnvStringList(key: string, fallback?: string[]): string[] {
  const raw = process.env[key]
  if ((raw === undefined || raw.trim() === '') && fallback) return fallback
  if (raw === undefined) throw new Error(`Missing env: ${key}`)
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}
