/** Server-only configuration, read lazily so tests can set env before first use. */
export function env() {
  const required = (key: string): string => {
    const v = process.env[key];
    if (!v) throw new Error(`Missing env ${key}`);
    return v;
  };
  return {
    databaseUrl: () => required("APP_DATABASE_URL"),
    jwtSecret: () => required("JWT_SECRET"),
    /** Per-instance pool. Serverless: keep it tiny and put a transaction-mode pooler in front. */
    dbPoolMax: Number(process.env.APP_DB_POOL_MAX ?? 3),
    demoLoginEnabled: process.env.DEMO_LOGIN_ENABLED === "true",
  };
}
