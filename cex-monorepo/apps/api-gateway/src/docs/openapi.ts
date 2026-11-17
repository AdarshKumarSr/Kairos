import type { FastifyPluginAsync } from 'fastify';

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Kairos Spot Crypto Exchange API',
    version: '1.0.0',
    description:
      'High-performance spot cryptocurrency exchange REST API featuring strict BigInt money scaling (1e8), deterministic order execution, and low-latency matching.',
  },
  servers: [{ url: '/api/v1', description: 'API v1' }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
    schemas: {
      ErrorResponse: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              details: { type: 'object' },
            },
            required: ['code', 'message'],
          },
        },
      },
      PlaceOrderRequest: {
        type: 'object',
        required: ['market', 'side', 'type'],
        properties: {
          market: { type: 'string', example: 'SOL_USDT' },
          side: { type: 'string', enum: ['BUY', 'SELL'] },
          type: { type: 'string', enum: ['LIMIT', 'MARKET'] },
          price: { type: 'string', example: '14250000000', description: 'Scaled by 1e8' },
          quantity: { type: 'string', example: '1000000000', description: 'Scaled by 1e8' },
          quoteQuantity: { type: 'string', description: 'Quote quantity budget for MARKET BUY' },
          postOnly: { type: 'boolean', default: false },
          ioc: { type: 'boolean', default: false },
          clientOrderId: { type: 'string', example: 'bot-0001' },
        },
      },
      OrderResponse: {
        type: 'object',
        properties: {
          orderId: { type: 'string' },
          status: { type: 'string', enum: ['NEW', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED'] },
          filledQuantity: { type: 'string' },
          avgPrice: { type: 'string' },
        },
      },
      BalanceItem: {
        type: 'object',
        properties: {
          asset: { type: 'string' },
          available: { type: 'string' },
          locked: { type: 'string' },
        },
      },
      MarketConfig: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          baseAsset: { type: 'string' },
          quoteAsset: { type: 'string' },
          tickSize: { type: 'string' },
          lotSize: { type: 'string' },
          minNotional: { type: 'string' },
          makerFeeBps: { type: 'number' },
          takerFeeBps: { type: 'number' },
          status: { type: 'string' },
        },
      },
    },
  },
  paths: {
    '/healthz': {
      get: {
        summary: 'Liveness & health check',
        responses: { '200': { description: 'Service is healthy' } },
      },
    },
    '/auth/signup': {
      post: {
        summary: 'Register new account',
        responses: { '201': { description: 'User registered' } },
      },
    },
    '/auth/signin': {
      post: {
        summary: 'Authenticate user',
        responses: { '200': { description: 'Access token and session cookie' } },
      },
    },
    '/order': {
      post: {
        summary: 'Place order',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/PlaceOrderRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Order accepted by matching engine',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderResponse' } } },
          },
          '202': { description: 'Order pending execution' },
          '400': { description: 'Validation error' },
          '401': { description: 'Unauthorized' },
          '422': { description: 'Order rejected by business rules' },
          '429': { description: 'Rate limit exceeded' },
          '503': { description: 'Engine overloaded' },
        },
      },
    },
    '/order/{orderId}': {
      delete: {
        summary: 'Cancel open order',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Order cancelled' },
          '401': { description: 'Unauthorized' },
          '403': { description: 'Cannot cancel another user order' },
          '404': { description: 'Order not found' },
        },
      },
      get: {
        summary: 'Get order details',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Order details' },
          '404': { description: 'Order not found' },
        },
      },
    },
    '/orders/open': {
      get: {
        summary: 'List user open orders',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'market', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'Open orders list' } },
      },
    },
    '/balances': {
      get: {
        summary: 'Get wallet balances',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Asset balances' } },
      },
    },
    '/markets': {
      get: {
        summary: 'Get public market configurations',
        responses: { '200': { description: 'List of active markets' } },
      },
    },
    '/depth': {
      get: {
        summary: 'Get L2 order book depth snapshot',
        parameters: [
          { name: 'market', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: { '200': { description: 'Order book depth' } },
      },
    },
  },
};

export const docsRoutes: FastifyPluginAsync = async (app) => {
  // Serve OpenAPI JSON schema
  app.get('/docs/openapi.json', async () => openApiDocument);

  // Serve interactive Swagger UI HTML
  app.get('/docs', async (_req, reply) => {
    reply.type('text/html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Kairos CEX API Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css" />
  <style>
    body { margin: 0; background: #0b0e14; color: #fff; }
    .swagger-ui .topbar { display: none; }
    .swagger-ui { filter: invert(88%) hue-rotate(180deg); }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      SwaggerUIBundle({
        url: '/docs/openapi.json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
        layout: "BaseLayout",
        deepLinking: true
      });
    };
  </script>
</body>
</html>`);
  });
};
