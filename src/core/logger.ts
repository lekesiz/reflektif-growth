import { pino } from "pino";
import { env } from "../config/env";

const usePretty = process.stdout.isTTY;

export const logger = pino({
  level: env.LOG_LEVEL,
  ...(usePretty
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }
    : {}),
});

export const childLogger = (mod: string) => logger.child({ mod });
