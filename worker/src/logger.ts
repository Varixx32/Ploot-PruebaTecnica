import pino from "pino";

/** JSON logs, one line per event: greppable by post_id / ambassador_id / outcome. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "worker" },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Tokens never reach a log line, even by accident.
  redact: { paths: ["*.access_token", "*.refresh_token", "*.authorization", "token"], censor: "[redacted]" },
});

export type Logger = typeof logger;
