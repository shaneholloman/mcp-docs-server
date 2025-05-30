import axios, { type AxiosError, type AxiosRequestConfig } from "axios";
import { CancellationError } from "../../pipeline/errors";
import { FETCHER_BASE_DELAY, FETCHER_MAX_RETRIES } from "../../utils/config";
import { RedirectError, ScraperError } from "../../utils/errors";
import { logger } from "../../utils/logger";
import { MimeTypeUtils } from "../../utils/mimeTypeUtils";
import { FingerprintGenerator } from "./FingerprintGenerator";
import type { ContentFetcher, FetchOptions, RawContent } from "./types";

/**
 * Fetches content from remote sources using HTTP/HTTPS.
 */
export class HttpFetcher implements ContentFetcher {
  private readonly retryableStatusCodes = [
    408, // Request Timeout
    429, // Too Many Requests
    500, // Internal Server Error
    502, // Bad Gateway
    503, // Service Unavailable
    504, // Gateway Timeout
    525, // SSL Handshake Failed (Cloudflare specific)
  ];

  private fingerprintGenerator: FingerprintGenerator;

  constructor() {
    this.fingerprintGenerator = new FingerprintGenerator();
  }

  canFetch(source: string): boolean {
    return source.startsWith("http://") || source.startsWith("https://");
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async fetch(source: string, options?: FetchOptions): Promise<RawContent> {
    const maxRetries = options?.maxRetries ?? FETCHER_MAX_RETRIES;
    const baseDelay = options?.retryDelay ?? FETCHER_BASE_DELAY;
    // Default to following redirects if not specified
    const followRedirects = options?.followRedirects ?? true;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const fingerprint = this.fingerprintGenerator.generateHeaders();
        const headers = {
          ...fingerprint,
          ...options?.headers, // User-provided headers override generated ones
        };

        const config: AxiosRequestConfig = {
          responseType: "arraybuffer", // For handling both text and binary
          headers,
          timeout: options?.timeout,
          signal: options?.signal, // Pass signal to axios
          // Axios follows redirects by default, we need to explicitly disable it if needed
          maxRedirects: followRedirects ? 5 : 0,
        };

        const response = await axios.get(source, config);

        const contentTypeHeader = response.headers["content-type"];
        const { mimeType, charset } = MimeTypeUtils.parseContentType(contentTypeHeader);
        const contentEncoding = response.headers["content-encoding"];

        return {
          content: response.data,
          mimeType,
          charset,
          encoding: contentEncoding,
          source: source,
        } satisfies RawContent;
      } catch (error: unknown) {
        const axiosError = error as AxiosError;
        const status = axiosError.response?.status;
        const code = axiosError.code;

        // Handle abort/cancel: do not retry, throw CancellationError
        if (options?.signal?.aborted || code === "ERR_CANCELED") {
          // Throw with isError = false to indicate cancellation is not an error
          throw new CancellationError("HTTP fetch cancelled");
        }

        // Handle redirect errors (status codes 301, 302, 303, 307, 308)
        if (!followRedirects && status && status >= 300 && status < 400) {
          const location = axiosError.response?.headers?.location;
          if (location) {
            throw new RedirectError(source, location, status);
          }
        }

        if (
          attempt < maxRetries &&
          (status === undefined || this.retryableStatusCodes.includes(status))
        ) {
          const delay = baseDelay * 2 ** attempt;
          logger.warn(
            `⚠️  Attempt ${attempt + 1}/${
              maxRetries + 1
            } failed for ${source} (Status: ${status}, Code: ${code}). Retrying in ${delay}ms...`,
          );
          await this.delay(delay);
          continue;
        }

        // Not a 5xx error or max retries reached
        throw new ScraperError(
          `Failed to fetch ${source} after ${
            attempt + 1
          } attempts: ${axiosError.message ?? "Unknown error"}`,
          true,
          error instanceof Error ? error : undefined,
        );
      }
    }
    throw new ScraperError(
      `Failed to fetch ${source} after ${maxRetries + 1} attempts`,
      true,
    );
  }
}
