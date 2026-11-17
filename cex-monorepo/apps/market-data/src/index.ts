import { pathToFileURL } from 'node:url';
import { BookMirror } from './book-mirror.js';
import { CandleManager } from './candle-manager.js';
import { DepthThrottler } from './depth-throttler.js';
import { Rolling24hStats } from './rolling-stats.js';
import { MarketDataService, parseStreamFields } from './service.js';

export {
  BookMirror,
  CandleManager,
  DepthThrottler,
  MarketDataService,
  parseStreamFields,
  Rolling24hStats,
};

export type * from './types.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = new MarketDataService();

  const shutdown = async () => {
    console.log('Stopping Market Data Service...');
    await service.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  service
    .start()
    .then(() => {
      console.log('Market Data Service started and consuming engine events...');
    })
    .catch((err) => {
      console.error('Market Data Service failed to start:', err);
      process.exit(1);
    });
}
