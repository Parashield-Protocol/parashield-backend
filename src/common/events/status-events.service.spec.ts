import { StatusEventsService } from './status-events.service';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'events';

describe('StatusEventsService', () => {
  function build(configuredMaxListeners?: string) {
    const config = {
      get: jest.fn((key: string) => key === 'STATUS_EVENTS_MAX_LISTENERS' ? configuredMaxListeners : undefined),
    };
    const service = new StatusEventsService(undefined, undefined, config as unknown as ConfigService);

    return { service, config };
  }

  it('uses the configured maximum listener count', () => {
    const { service } = build('250');

    expect((service as unknown as { emitter: EventEmitter }).emitter.getMaxListeners()).toBe(250);
  });

  it.each([undefined, '', '0', '-1', '1.5', 'not-a-number'])(
    'uses the default maximum listener count for invalid configuration (%s)',
    (configuredMaxListeners) => {
      const { service } = build(configuredMaxListeners);

      expect((service as unknown as { emitter: EventEmitter }).emitter.getMaxListeners()).toBe(1000);
    },
  );
});