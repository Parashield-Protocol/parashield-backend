import { Logger } from '@nestjs/common';

export async function initializeOpenTelemetry(): Promise<void> {
  if (process.env['OTEL_SDK_DISABLED']?.toLowerCase() === 'true') {
    return;
  }

  try {
    // Optional dependency: if the packages are installed, start full tracing.
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { Resource } = require('@opentelemetry/resources');
    const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

    const sdk = new NodeSDK({
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
                    .map((pair) => pair.split('=', 2).map((part) => part.trim()))
                    .filter(([key, value]) => key && value),
                )
              : undefined,
          })
        : undefined,
      instrumentations: [getNodeAutoInstrumentations()],
    });

    await sdk.start();
    const logger = new Logger('OpenTelemetry');
    logger.log('OpenTelemetry initialized');
  } catch (error) {
    const logger = new Logger('OpenTelemetry');
    logger.warn(
      `OpenTelemetry not initialized: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
