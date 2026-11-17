import { pathToFileURL } from 'node:url';
import { Side } from '@cex/types';
import { EngineRunner } from './runner/runner.js';

export const supportedSides = [Side.BUY, Side.SELL] as const;

export * from './balance/index.js';
export * from './book/index.js';
export * from './engine/index.js';
export * from './persistence/index.js';
export * from './runner/index.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  EngineRunner.createWithRecovery()
    .then((runner) => {
      const shutdown = async () => {
        console.log('Shutting down Engine Runner...');
        await runner.stop();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      return runner.start().then(() => {
        console.log('Matching Engine Runner started and consuming commands...');
      });
    })
    .catch((err) => {
      console.error('Matching Engine Runner failed to start:', err);
      process.exit(1);
    });
}
