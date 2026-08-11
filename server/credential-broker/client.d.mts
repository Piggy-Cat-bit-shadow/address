export interface CredentialBrokerProviderStatus {
  provider: string;
  known: boolean;
  available: boolean;
  nextResetAt: string | null;
  waitState: string | null;
  reason: string | null;
  revision: string;
}

export class CredentialBrokerClient {
  constructor(options: { url: string; token: string; fetchImpl?: typeof fetch });
  readonly url: string;
  readonly token: string;
  request(
    operation: string,
    parameters: Record<string, unknown>,
    options?: { requestId?: string; signal?: AbortSignal }
  ): Promise<unknown>;
  availability(
    providers: string[],
    options?: { signal?: AbortSignal }
  ): Promise<Record<string, CredentialBrokerProviderStatus>>;
}

export function createCredentialBrokerClient(
  environment?: Record<string, string | undefined>,
  options?: { fetchImpl?: typeof fetch }
): Promise<CredentialBrokerClient | null>;
