import type { WebSocket } from 'ws';

export interface ClientSubscribeMessage {
  method: 'SUBSCRIBE';
  params: string[];
  id?: number | string | undefined;
}

export interface ClientUnsubscribeMessage {
  method: 'UNSUBSCRIBE';
  params: string[];
  id?: number | string | undefined;
}

export interface ClientAuthMessage {
  method: 'AUTH';
  token: string;
  id?: number | string | undefined;
}

export interface ClientPingMessage {
  method: 'PING';
  id?: number | string | undefined;
}

export type ClientMessage =
  | ClientSubscribeMessage
  | ClientUnsubscribeMessage
  | ClientAuthMessage
  | ClientPingMessage;

export interface ServerSuccessResponse {
  result: unknown;
  id?: number | string | undefined;
}

export interface ServerErrorResponse {
  error: {
    code: number;
    message: string;
  };
  id?: number | string | undefined;
}

export interface DepthSnapshotPayload {
  e: 'depthSnapshot';
  s: string;
  seq: string;
  b: [string, string][];
  a: [string, string][];
}

export interface ConnectionState {
  id: string;
  socket: WebSocket;
  userId: string | null;
  subscriptions: Set<string>;
  depthLastSeq: Map<string, bigint>;
  depthPendingSnapshot: Set<string>;
  isAlive: boolean;
  missedPongs: number;
  messageCount: number;
  rateLimitWindowStart: number;
}

export interface WsServerMetrics {
  ws_connections: number;
  ws_messages_out_total: number;
}

export interface WsServerOptions {
  port?: number;
  redisUrl?: string;
  jwtSecret?: string;
  pingIntervalMs?: number;
  maxSubscriptions?: number;
  rateLimitPerSec?: number;
  maxBufferedAmount?: number;
}
