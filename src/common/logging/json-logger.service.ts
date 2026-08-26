import { ConsoleLogger, LogLevel } from '@nestjs/common';

/**
 * JsonLogger — structured JSON log output (#352).
 *
 * NestJS's default Logger prints human-formatted colored text, which isn't
 * machine-parseable by a log aggregator (CloudWatch/Datadog/Loki/etc.)
 * without a fragile regex. Registered once via app.useLogger() in main.ts,
 * this backs every existing `new Logger(ClassName)` call site across the
 * project (Nest routes all Logger instance calls through whatever
 * LoggerService is registered globally), so no call site needs to change.
 *
 * Prometheus metrics and OpenTelemetry tracing (also requested in #352) are
 * a materially larger scope than log formatting: they need a metrics
 * registry wired through every request path and a trace exporter pointed
 * at a real collector endpoint, neither of which exists anywhere in this
 * project's config today. Left out of this fix rather than stood up with a
 * fabricated/unverified OTLP endpoint -- noted as a follow-up.
 */
export class JsonLogger extends ConsoleLogger {
  constructor() {
    // colors: false so contextMessage below is plain `[Context] ` text,
    // not ANSI-escaped -- JSON log lines shouldn't carry terminal color codes.
    super({ colors: false });
  }

  protected formatMessage(
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
  ): string {
    const context = contextMessage.trim().replace(/^\[|\]$/g, '') || undefined;
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level:     logLevel,
      context,
      message:   typeof message === 'string' ? message : this.stringifyMessageForJson(message),
    };
    return `${JSON.stringify(entry)}\n`;
  }

  private stringifyMessageForJson(message: unknown): string {
    if (message instanceof Error) {
      return message.stack ?? message.message;
    }
    try {
      return JSON.stringify(message);
    } catch {
      return String(message);
    }
  }
}
