// src/lib/auth.ts
import { readFile } from "fs/promises";
import { execFile as execFileCallback } from "child_process";
import { promisify } from "util";
import * as os from "os";
import { AuthError, type AuthProvider } from "./types.js";

const execFile = promisify(execFileCallback);

// Module-level cache for session token
interface SessionToken {
  token: string;
  expires_at: number;
}

let cachedSession: SessionToken | null = null;
let cachedOAuthToken: string | null = null;
let refreshPromise: Promise<SessionToken> | null = null;

const EXPIRY_BUFFER_SECONDS = 60;

/**
 * Clears the cached session token and refresh promise.
 * Used primarily for testing.
 * @internal
 */
export function clearSessionCache(): void {
  cachedSession = null;
  cachedOAuthToken = null;
  refreshPromise = null;
}

/**
 * Redacts a token for safe logging: shows first 4 and last 4 chars, hides the rest.
 */
function redactToken(token: string): string {
  if (token.length <= 16) return "****";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

/**
 * Resolves GitHub OAuth token from multiple sources in order:
 * 1. $GITHUB_TOKEN environment variable
 * 2. Copilot config files (~/.config/github-copilot/hosts.json, apps.json)
 * 3. gh CLI (via `gh auth token -h github.com`)
 *
 * @returns GitHub OAuth token
 * @throws AuthError with code "no_token" if no token found
 */
export async function resolveToken(): Promise<string> {
  // Source 1: Environment variable
  const envToken = process.env.GITHUB_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  // Source 2: Copilot config files
  const homeDir = os.homedir();
  const configPaths = [
    `${homeDir}/.config/github-copilot/hosts.json`,
    `${homeDir}/.config/github-copilot/apps.json`,
  ];

  for (const configPath of configPaths) {
    try {
      const content = await readFile(configPath, "utf-8");
      const config = JSON.parse(content);

      // Look for github.com entry with oauth_token
      for (const [host, data] of Object.entries(config)) {
        if (host.includes("github.com") && typeof data === "object" && data !== null) {
          const oauth_token = (data as any).oauth_token;
          if (typeof oauth_token === "string" && oauth_token.length > 0) {
            return oauth_token;
          }
        }
      }
    } catch (err) {
      // Config file doesn't exist or is malformed, continue to next source
      continue;
    }
  }

  // Source 3: gh CLI
  try {
    const { stdout } = await execFile("gh", ["auth", "token", "-h", "github.com"]);
    const token = stdout.trim();
    if (token.length > 0) {
      return token;
    }
  } catch (err) {
    // gh CLI failed or not installed
  }

  // All sources failed
  throw new AuthError(
    "no_token",
    "No GitHub token found. Either set $GITHUB_TOKEN, run `gh auth login`, or sign in to Copilot in your editor.",
    false
  );
}

/**
 * Exchanges a GitHub OAuth token for a Copilot session token.
 * Caches the result and implements mutex for concurrent callers.
 *
 * @param oauthToken GitHub OAuth token
 * @returns Session token with expiration timestamp
 * @throws AuthError with code "exchange_failed" on HTTP error
 */
export async function exchangeSessionToken(oauthToken: string): Promise<SessionToken> {
  const now = Math.floor(Date.now() / 1000);

  // Return cached token if valid and for the same OAuth identity
  if (
    cachedSession &&
    cachedOAuthToken === oauthToken &&
    cachedSession.expires_at > now + EXPIRY_BUFFER_SECONDS
  ) {
    return cachedSession;
  }

  // If a refresh is already in progress, wait for it (mutex)
  if (refreshPromise) {
    return refreshPromise;
  }

  // Start a new refresh
  refreshPromise = (async () => {
    try {
      let response: Response;
      try {
        response = await fetch("https://api.github.com/copilot_internal/v2/token", {
          headers: {
            Authorization: `Token ${oauthToken}`,
            Accept: "application/json",
          },
        });
      } catch (err) {
        throw new AuthError(
          "exchange_failed",
          `Network error during token exchange: ${err instanceof Error ? err.message : String(err)} (token: ${redactToken(oauthToken)})`,
          false,
          err instanceof Error ? err : undefined
        );
      }

      if (!response.ok) {
        throw new AuthError(
          "exchange_failed",
          `Failed to exchange OAuth token for session token: ${response.status} ${response.statusText} (token: ${redactToken(oauthToken)})`,
          false
        );
      }

      let rawData: unknown;
      try {
        rawData = await response.json();
      } catch (err) {
        throw new AuthError(
          "exchange_failed",
          `Invalid JSON response from token exchange (token: ${redactToken(oauthToken)})`,
          false,
          err instanceof Error ? err : undefined
        );
      }

      // Validate response schema before caching
      if (
        !rawData ||
        typeof rawData !== "object" ||
        Array.isArray(rawData)
      ) {
        throw new AuthError(
          "exchange_failed",
          `Invalid token exchange response schema (token: ${redactToken(oauthToken)})`,
          false
        );
      }

      const data = rawData as Record<string, unknown>;
      if (
        typeof data.token !== "string" ||
        data.token.length === 0 ||
        typeof data.expires_at !== "number" ||
        data.expires_at <= 0
      ) {
        throw new AuthError(
          "exchange_failed",
          `Invalid token exchange response schema (token: ${redactToken(oauthToken)})`,
          false
        );
      }

      // Reject already-expired tokens (server clock skew)
      if (data.expires_at <= now) {
        throw new AuthError(
          "exchange_failed",
          `Token exchange returned already-expired token (token: ${redactToken(oauthToken)})`,
          false
        );
      }

      cachedSession = {
        token: data.token as string,
        expires_at: data.expires_at as number,
      };
      cachedOAuthToken = oauthToken;

      return cachedSession;
    } catch (err) {
      // Clear stale cache on any error
      cachedSession = null;
      cachedOAuthToken = null;
      throw err;
    } finally {
      // Clear the mutex promise
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * Obtains authenticated HTTP headers for Copilot API calls.
 * Chains token resolution and session token exchange.
 *
 * @returns Headers object with Bearer token
 * @throws AuthError if authentication fails at any stage
 */
export async function getAuthenticatedHeaders(): Promise<Record<string, string>> {
  const oauthToken = await resolveToken();
  const session = await exchangeSessionToken(oauthToken);

  return {
    Authorization: `Bearer ${session.token}`,
  };
}

/**
 * Creates a default AuthProvider implementation.
 *
 * @returns AuthProvider that uses the default token resolution chain
 */
export function createDefaultAuthProvider(): AuthProvider {
  return {
    getAuthenticatedHeaders,
  };
}
