// ============================================================
// AuthManager — Multi-key isolation for Ozon API credentials
// ============================================================

import type { OzonCredentials } from "@onzo/shared-types";

export class AuthManager {
  private clients: Map<string, OzonCredentials> = new Map();
  private defaultClientId: string | null = null;

  constructor(config: {
    clients: OzonCredentials[];
    defaultClient?: string;
  }) {
    if (config.clients.length === 0) {
      throw new Error("AuthManager requires at least one client credential");
    }

    for (const client of config.clients) {
      const key = client.storeId ?? client.clientId;
      this.clients.set(key, client);
    }

    this.defaultClientId = config.defaultClient ?? config.clients[0].clientId;
  }

  /**
   * Get API request headers for a specific client.
   */
  getHeaders(clientId?: string): { "Client-Id": string; "Api-Key": string } {
    const client = this.resolveClient(clientId);

    return {
      "Client-Id": client.clientId,
      "Api-Key": client.apiKey,
    };
  }

  /**
   * Get full credentials for a client.
   */
  getClient(clientId?: string): OzonCredentials {
    return this.resolveClient(clientId);
  }

  /**
   * The default client credentials.
   */
  get default(): OzonCredentials {
    return this.resolveClient(this.defaultClientId!);
  }

  /**
   * List all registered clients.
   */
  listClients(): Array<{ clientId: string; storeId?: string }> {
    return Array.from(this.clients.values()).map((c) => ({
      clientId: c.clientId,
      storeId: c.storeId,
    }));
  }

  /**
   * Add or update a client at runtime.
   */
  upsertClient(credentials: OzonCredentials): void {
    const key = credentials.storeId ?? credentials.clientId;
    this.clients.set(key, credentials);
  }

  /**
   * Remove a client by storeId or clientId.
   */
  removeClient(identifier: string): boolean {
    // Try direct key match first (storeId or clientId used at registration)
    if (this.clients.delete(identifier)) return true;
    // Also try matching by clientId field
    for (const [key, cred] of this.clients) {
      if (cred.clientId === identifier) {
        return this.clients.delete(key);
      }
    }
    return false;
  }

  // ---- private ----

  private resolveClient(clientId?: string): OzonCredentials {
    if (clientId) {
      const client = this.clients.get(clientId);
      if (client) return client;
    }

    // Try default
    if (this.defaultClientId) {
      const client = this.clients.get(this.defaultClientId);
      if (client) return client;
    }

    // Fallback to first available
    const first = this.clients.values().next().value;
    if (first) return first;

    throw new Error("No Ozon client credentials available");
  }
}
