import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ClawpumpConfigError,
  ClawpumpHttpError,
  ClawpumpNetworkError,
  ClawpumpOperation,
} from './errorMapping.js';

export interface ClawpumpClientConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  healthPath: string;
  launchPath: string;
  earningsPath: string;
  maxImageBytes: number;
}

export interface ClawpumpLaunchInput {
  name: string;
  symbol: string;
  description: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  imagePath?: string;
  walletAddress: string;
}

const sanitizePath = (value: string): string => (value.startsWith('/') ? value : `/${value}`);

const parseRetryAfter = (headerValue: string | null): number | undefined => {
  if (!headerValue) return undefined;
  const retryAfter = Number(headerValue);
  return Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined;
};

const resolveImagePath = (imagePath: string): string => {
  if (path.isAbsolute(imagePath)) return imagePath;
  return path.resolve(process.cwd(), imagePath);
};

const mimeByExtension: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const resolveMimeType = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  const mime = mimeByExtension[ext];

  if (!mime) {
    throw new ClawpumpConfigError('Unsupported image format for imagePath.', {
      field: 'imagePath',
      allowedExtensions: Object.keys(mimeByExtension),
    });
  }

  return mime;
};

export class ClawpumpClient {
  constructor(private readonly config: ClawpumpClientConfig) {}

  private get baseUrl(): string {
    const baseUrl = this.config.baseUrl.trim();
    if (!baseUrl) {
      throw new ClawpumpConfigError('CLAWPUMP_BASE_URL is not configured.', {
        requiredEnv: 'CLAWPUMP_BASE_URL',
      });
    }

    return baseUrl;
  }

  private buildUrl(endpointPath: string): string {
    return new URL(sanitizePath(endpointPath), this.baseUrl).toString();
  }

  private async fetchJson<T>(operation: ClawpumpOperation, url: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const headers = new Headers(init?.headers);
      headers.set('accept', 'application/json');

      if (this.config.apiKey?.trim()) {
        headers.set('x-api-key', this.config.apiKey.trim());
      }

      const response = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });

      const bodyText = await response.text();

      if (!response.ok) {
        throw new ClawpumpHttpError(
          operation,
          response.status,
          bodyText,
          parseRetryAfter(response.headers.get('retry-after')),
        );
      }

      if (!bodyText.trim()) {
        return {} as T;
      }

      return JSON.parse(bodyText) as T;
    } catch (error) {
      if (error instanceof ClawpumpHttpError || error instanceof ClawpumpConfigError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }

      throw new ClawpumpNetworkError(operation, 'Failed to call clawpump endpoint.');
    } finally {
      clearTimeout(timeout);
    }
  }

  async health(): Promise<unknown> {
    const url = this.buildUrl(this.config.healthPath);
    return this.fetchJson('health', url, { method: 'GET' });
  }

  async earnings(agentId: string): Promise<unknown> {
    const url = new URL(this.buildUrl(this.config.earningsPath));
    url.searchParams.set('agentId', agentId);
    return this.fetchJson('earnings', url.toString(), { method: 'GET' });
  }

  async launch(payload: ClawpumpLaunchInput): Promise<unknown> {
    const url = this.buildUrl(this.config.launchPath);

    if (!payload.imagePath) {
      return this.fetchJson('launch', url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    }

    const resolvedImagePath = resolveImagePath(payload.imagePath);
    const imageStats = await fs.stat(resolvedImagePath);

    if (!imageStats.isFile()) {
      throw new ClawpumpConfigError('imagePath must point to a file.', {
        field: 'imagePath',
      });
    }

    if (imageStats.size > this.config.maxImageBytes) {
      throw new ClawpumpConfigError('imagePath exceeds configured maximum file size.', {
        field: 'imagePath',
        maxImageBytes: this.config.maxImageBytes,
      });
    }

    const mimeType = resolveMimeType(resolvedImagePath);
    const fileBytes = await fs.readFile(resolvedImagePath);

    const form = new FormData();
    form.set('name', payload.name);
    form.set('symbol', payload.symbol);
    form.set('description', payload.description);
    form.set('walletAddress', payload.walletAddress);

    if (payload.website) form.set('website', payload.website);
    if (payload.twitter) form.set('twitter', payload.twitter);
    if (payload.telegram) form.set('telegram', payload.telegram);

    form.set('image', new Blob([fileBytes], { type: String(mimeType) }), path.basename(resolvedImagePath));

    return this.fetchJson('launch', url, {
      method: 'POST',
      body: form,
    });
  }
}
