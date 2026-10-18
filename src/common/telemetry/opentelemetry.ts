import { Logger, Injectable, BeforeApplicationShutdown } from '@nestjs/common';

export const DEFAULT_OTEL_SHUTDOWN_TIMEOUT_MS = 5000;

interface OpenTelemetrySdk {
  start: () => Promise<void>;
  shutdown: () => Promise<void>;
}

let activeSdk: OpenTelemetrySdk | null = null;
let isShuttingDown = false;
let isShutdownComplete = false;
let activeShutdownPromise: Promise<boolean> | null = null;
let signalHandlersRegistered = false;

/**
 * Initialize OpenTelemetry Node SDK.
 */
export async function initializeOpenTelemetry(): Promise<void> {
  if (process.env['OTEL_SDK_DISABLED']?.toLowerCase() === 'true') {
    const logger = new Logger('OpenTelemetry');
    logger.log('OpenTelemetry disabled by OTEL_SDK_DISABLED=true');
    return;
  }

  try {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { Resource } = require('@opentelemetry/resources');
    const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

    const sdk: OpenTelemetrySdk = new NodeSDK({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: process.env['OTEL_SERVICE_NAME'] ?? 'parashield-backend',
        [SemanticResourceAttributes.SERVICE_VERSION]: process.env['npm_package_version'] ?? '0.1.0',
      }),
      traceExporter: process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
        ? new OTLPTraceExporter({
            url: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
            headers: process.env['OTEL_EXPORTER_OTLP_HEADERS']
              ? Object.fromEntries(
                  process.env['OTEL_EXPORTER_OTLP_HEADERS']
                    .split(',')
                    .map((pair: string) => pair.split('=', 2).map((part: string) => part.trim()))
                    .filter(([key, value]: [string, string]) => key && value),
                )
              : undefined,
          })
        : undefined,
      instrumentations: [getNodeAutoInstrumentations()],
    });

    await sdk.start();
    activeSdk = sdk;
    isShuttingDown = false;
    isShutdownComplete = false;
    activeShutdownPromise = null;

    const logger = new Logger('OpenTelemetry');
    logger.log('OpenTelemetry initialized');
  } catch (error) {
    const logger = new Logger('OpenTelemetry');
    logger.warn(
      `OpenTelemetry not initialized: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Gracefully flush and shut down the OpenTelemetry SDK (#715).
 *
 * Enforces a timeout so a hanging exporter cannot block process termination forever.
 * Idempotent: repeated calls or signals while shutting down await the ongoing flush.
 * No-op when tracing is disabled or not started.
 */
export async function shutdownOpenTelemetry(options?: {
  timeoutMs?: number;
  signal?: string;
  exitProcess?: boolean;
  exitCode?: number;
}): Promise<boolean> {
  const logger = new Logger('OpenTelemetry');

  if (process.env['OTEL_SDK_DISABLED']?.toLowerCase() === 'true') {
    logger.debug?.('OpenTelemetry shutdown skipped: tracing is disabled');
    return true;
  }

  if (isShutdownComplete || !activeSdk) {
    return true;
  }

  // Idempotency: if already shutting down, return the in-flight shutdown promise
  if (isShuttingDown && activeShutdownPromise) {
    logger.log('OpenTelemetry shutdown already in progress; awaiting existing flush');
    return activeShutdownPromise;
  }

  isShuttingDown = true;

  const timeoutMs =
    options?.timeoutMs ??
    parseInt(process.env['OTEL_SHUTDOWN_TIMEOUT_MS'] ?? process.env['OTEL_FLUSH_TIMEOUT_MS'] ?? '', 10) ||
    DEFAULT_OTEL_SHUTDOWN_TIMEOUT_MS;

  const sdkToShutdown = activeSdk;

  activeShutdownPromise = (async (): Promise<boolean> => {
    logger.log(
      `Flushing and shutting down OpenTelemetry SDK (timeout: ${timeoutMs}ms${options?.signal ? `, signal: ${options.signal}` : ''})...`,
    );

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    });

    try {
      const shutdownPromise = Promise.resolve(sdkToShutdown.shutdown()).then(() => 'success' as const);
      const outcome = await Promise.race([shutdownPromise, timeoutPromise]);

      if (timer) clearTimeout(timer);

      if (outcome === 'success') {
        logger.log('OpenTelemetry SDK flushed and shut down successfully');
        isShutdownComplete = true;
        activeSdk = null;
        return true;
      } else {
        logger.warn(`OpenTelemetry shutdown timed out after ${timeoutMs}ms; abandoning flush`);
        isShutdownComplete = true;
        activeSdk = null;
        return false;
      }
    } catch (err) {
      if (timer) clearTimeout(timer);
      logger.warn(
        `OpenTelemetry shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      isShutdownComplete = true;
      activeSdk = null;
      return false;
    } finally {
      isShuttingDown = false;
      if (options?.exitProcess) {
        process.exit(options.exitCode ?? 0);
      }
    }
  })();

  return activeShutdownPromise;
}

/**
 * Register standalone signal listeners on SIGTERM and SIGINT (#715)
 * when not running inside NestJS shutdown hooks or when explicit signal
 * handling is needed. Ensures no duplicate registrations.
 */
export function registerOtelSignalHandlers(timeoutMs = DEFAULT_OTEL_SHUTDOWN_TIMEOUT_MS): void {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;

  const handleSignal = async (signal: 'SIGTERM' | 'SIGINT') => {
    const logger = new Logger('OpenTelemetry');
    logger.log(`Received ${signal}; initiating OpenTelemetry shutdown`);
    await shutdownOpenTelemetry({ signal, timeoutMs });
  };

  process.on('SIGTERM', () => {
    handleSignal('SIGTERM').catch(() => {});
  });
  process.on('SIGINT', () => {
    handleSignal('SIGINT').catch(() => {});
  });
}

/**
 * NestJS lifecycle hook provider (#715).
 * Hooks into beforeApplicationShutdown so the SDK is flushed AFTER the HTTP server
 * finishes in-flight requests and stops accepting new traffic, but BEFORE Prisma/Redis
 * connections are closed in onModuleDestroy.
 */
@Injectable()
export class OpenTelemetryShutdownHook implements BeforeApplicationShutdown {
  private readonly logger = new Logger(OpenTelemetryShutdownHook.name);

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Application shutdown initiated${signal ? ` (signal: ${signal})` : ''} — flushing OpenTelemetry`);
    await shutdownOpenTelemetry({ signal });
  }
}

/**
 * Internal helper for testing: inject a mock SDK or reset state.
 */
export function _setMockOpenTelemetrySdk(sdk: OpenTelemetrySdk | null): void {
  activeSdk = sdk;
  isShuttingDown = false;
  isShutdownComplete = false;
  activeShutdownPromise = null;
}

export function _resetOpenTelemetryState(): void {
  activeSdk = null;
  isShuttingDown = false;
  isShutdownComplete = false;
  activeShutdownPromise = null;
}
