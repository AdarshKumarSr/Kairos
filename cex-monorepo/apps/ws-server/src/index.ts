import { pathToFileURL } from 'node:url';
import { ConnectionManager } from './connection-manager.js';
import { RedisSubscriber } from './redis-subscriber.js';
import { WsServer } from './server.js';

export { ConnectionManager, RedisSubscriber, WsServer };
export type * from './types.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.WS_PORT ?? 8080);
  const server = new WsServer({ port });

  const shutdown = async () => {
    console.log('Shutting down WebSocket Server...');
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server
    .start()
    .then(() => {
      console.log(`Kairos WebSocket Server listening on port ${port}...`);
    })
    .catch((err) => {
      console.error('Failed to start WebSocket Server:', err);
      process.exit(1);
    });
}
