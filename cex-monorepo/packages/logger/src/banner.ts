import winston from 'winston';

export interface DependencyStatus {
  name: string;
  status: 'connected' | 'disconnected' | 'error' | 'connecting';
  detail?: string;
}

export interface RouteInfo {
  method: string;
  path: string;
  description?: string;
}

export interface StartupBannerOptions {
  serviceName: string;
  title?: string;
  version?: string;
  environment?: string;
  host?: string;
  port?: number;
  serviceType?: 'http' | 'ws' | 'worker';
  baseUrl?: string;
  healthUrl?: string;
  dependencies?: DependencyStatus[];
  routes?: RouteInfo[];
  streams?: string[];
  extraInfo?: Record<string, string>;
  logger?: winston.Logger;
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function padLine(content: string, width: number): string {
  const visibleLen = stripAnsi(content).length;
  const padding = Math.max(0, width - visibleLen);
  return `│ ${content}${' '.repeat(padding)} │`;
}

function centerText(text: string, width: number): string {
  const visibleLen = stripAnsi(text).length;
  const totalPad = Math.max(0, width - visibleLen);
  const leftPad = Math.floor(totalPad / 2);
  const rightPad = totalPad - leftPad;
  return ' '.repeat(leftPad) + text + ' '.repeat(rightPad);
}

export function formatStartupBanner(options: StartupBannerOptions): string {
  const BOX_WIDTH = 64; // Interior content width between border walls
  const lines: string[] = [];

  const title = options.title || `KAIROS CEX : ${options.serviceName.toUpperCase()}`;
  const env = options.environment || process.env.NODE_ENV || 'development';
  const type = options.serviceType || (options.port ? 'http' : 'worker');

  // Top border
  lines.push(`┌${'─'.repeat(BOX_WIDTH + 2)}┐`);

  // Title header
  lines.push(`│ ${centerText(title, BOX_WIDTH)} │`);
  lines.push(`├${'─'.repeat(BOX_WIDTH + 2)}┤`);

  // Basic service details
  lines.push(padLine(`Service      : ${options.serviceName}`, BOX_WIDTH));
  if (options.version) {
    lines.push(padLine(`Version      : ${options.version}`, BOX_WIDTH));
  }
  lines.push(padLine(`Environment  : ${env}`, BOX_WIDTH));

  if (type === 'http' || type === 'ws') {
    const host = options.host || '0.0.0.0';
    const port = options.port ?? 4000;
    lines.push(padLine(`Host & Port  : ${host}:${port}`, BOX_WIDTH));
    if (options.baseUrl) {
      lines.push(padLine(`Local URL    : ${options.baseUrl}`, BOX_WIDTH));
    }
    if (options.healthUrl) {
      lines.push(padLine(`Health Check : ${options.healthUrl}`, BOX_WIDTH));
    }
  } else {
    lines.push(padLine(`Service Type : Background Worker (Event-driven)`, BOX_WIDTH));
  }

  // Redis streams if applicable
  if (options.streams && options.streams.length > 0) {
    lines.push(padLine(`Streams      : ${options.streams.join(', ')}`, BOX_WIDTH));
  }

  // Dependencies status
  if (options.dependencies && options.dependencies.length > 0) {
    for (const dep of options.dependencies) {
      const icon = dep.status === 'connected' ? '🟢' : '🔴';
      const detailStr = dep.detail ? ` (${dep.detail})` : '';
      lines.push(padLine(`Dependency   : ${icon} ${dep.name}${detailStr}`, BOX_WIDTH));
    }
  }

  // Extra metadata
  if (options.extraInfo) {
    for (const [k, v] of Object.entries(options.extraInfo)) {
      lines.push(padLine(`${k.padEnd(12)} : ${v}`, BOX_WIDTH));
    }
  }

  // Routes list (if HTTP service)
  if (options.routes && options.routes.length > 0) {
    lines.push(`├${'─'.repeat(BOX_WIDTH + 2)}┤`);
    lines.push(padLine(`Available Endpoints:`, BOX_WIDTH));

    // Sort routes for clean display: healthz first, then by path
    const sorted = [...options.routes].sort((a, b) => {
      if (a.path === '/api/v1/healthz') return -1;
      if (b.path === '/api/v1/healthz') return 1;
      return a.path.localeCompare(b.path);
    });

    for (const r of sorted) {
      const method = r.method.padEnd(6);
      lines.push(padLine(`  ${method} ${r.path}`, BOX_WIDTH));
    }
  }

  // Bottom border
  lines.push(`└${'─'.repeat(BOX_WIDTH + 2)}┘`);

  return lines.join('\n');
}

export function printStartupBanner(options: StartupBannerOptions): void {
  const isProduction = (options.environment || process.env.NODE_ENV) === 'production';

  if (isProduction) {
    // In production, emit structured JSON so log aggregators (Loki, Datadog) don't get garbled
    const payload = {
      event: 'SERVICE_STARTUP',
      service: options.serviceName,
      environment: options.environment || 'production',
      port: options.port,
      host: options.host,
      healthUrl: options.healthUrl,
      dependencies: options.dependencies,
      routesCount: options.routes?.length ?? 0,
    };
    if (options.logger) {
      options.logger.info(`Service ${options.serviceName} started`, payload);
    } else {
      console.log(JSON.stringify(payload));
    }
  } else {
    // In development/staging, print the human-friendly visual ASCII box
    const banner = formatStartupBanner(options);
    console.log(`\n${banner}\n`);
  }
}
