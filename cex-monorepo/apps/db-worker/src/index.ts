import { pathToFileURL } from 'node:url';
import { rebuildDatabase } from './cli/rebuild.js';
import { EventProjector, mapToLedgerReason } from './projector.js';
import { DbWorker, parseStreamFields } from './worker.js';

export {
  DbWorker,
  EventProjector,
  mapToLedgerReason,
  parseStreamFields,
  rebuildDatabase,
};

export type * from './types.js';
export type * from './projector.js';
export type * from './cli/rebuild.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const worker = new DbWorker();

  const shutdown = async () => {
    console.log('Stopping DB worker...');
    await worker.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  worker
    .start()
    .then(() => {
      console.log('DB Worker started and listening for engine events...');
    })
    .catch((err) => {
      console.error('DB Worker failed to start:', err);
      process.exit(1);
    });
}
