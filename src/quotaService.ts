import { QuotaSnapshot, ModelQuotaInfo } from "./types";
import { GoogleAuthService, AuthState } from "./auth";
import { GoogleCloudCodeClient, GoogleApiError } from "./api";
import { logger } from "./utils/logger";
import { formatTimeUntilReset } from "./utils/timeUtils";


export enum QuotaApiMethod {
  GOOGLE_API = 'GOOGLE_API'
}


export class QuotaService {
  private readonly MAX_RETRY_COUNT = 3;
  private readonly RETRY_DELAY_MS = 5000;

  private lastSnapshot: QuotaSnapshot | undefined;
  private pollingInterval?: NodeJS.Timeout;
  private updateCallback?: (snapshot: QuotaSnapshot) => void;
  private errorCallback?: (error: Error) => void;
  private statusCallback?: (status: 'fetching' | 'retrying', retryCount?: number) => void;
  private authStatusCallback?: (needsLogin: boolean, isExpired: boolean) => void;
  private staleCallback?: (isStale: boolean) => void;
  private isFirstAttempt: boolean = true;
  private consecutiveErrors: number = 0;
  private retryCount: number = 0;
  private isRetrying: boolean = false;
  private isPollingTransition: boolean = false;
  private googleAuthService: GoogleAuthService;
  private googleApiClient: GoogleCloudCodeClient;
  private apiMethod: QuotaApiMethod = QuotaApiMethod.GOOGLE_API;

  constructor() {
    this.googleAuthService = GoogleAuthService.getInstance();
    this.googleApiClient = GoogleCloudCodeClient.getInstance();
  }

  getApiMethod(): QuotaApiMethod {
    return this.apiMethod;
  }

  setApiMethod(method: QuotaApiMethod): void {
    this.apiMethod = method;
    logger.info(`Switching to API: ${method}`);
  }






  onQuotaUpdate(callback: (snapshot: QuotaSnapshot) => void): void {
    this.updateCallback = callback;
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallback = callback;
  }

  onStatus(callback: (status: 'fetching' | 'retrying', retryCount?: number) => void): void {
    this.statusCallback = callback;
  }

  onAuthStatus(callback: (needsLogin: boolean, isExpired: boolean) => void): void {
    this.authStatusCallback = callback;
  }

  onStaleStatus(callback: (isStale: boolean) => void): void {
    this.staleCallback = callback;
  }

  async startPolling(intervalMs: number): Promise<void> {
    if (this.apiMethod === QuotaApiMethod.GOOGLE_API) {
      const authState = this.googleAuthService.getAuthState();
      if (authState.state === AuthState.NOT_AUTHENTICATED || authState.state === AuthState.TOKEN_EXPIRED) {
        logger.info('[QuotaService] Polling skipped: Google auth required');
        if (this.authStatusCallback) {
          this.authStatusCallback(true, authState.state === AuthState.TOKEN_EXPIRED);
        }
        this.stopPolling();
        this.consecutiveErrors = 0;
        this.retryCount = 0;
        this.isRetrying = false;
        return;
      }
    }

    if (this.isPollingTransition) {
      logger.info('[QuotaService] Polling transition in progress, skipping...');
      return;
    }

    this.isPollingTransition = true;
    try {
      logger.info(`[QuotaService] Starting polling loop every ${intervalMs}ms`);
      this.stopPolling();
      await this.fetchQuota();
      this.pollingInterval = setInterval(() => {
        this.fetchQuota();
      }, intervalMs);
    } finally {
      this.isPollingTransition = false;
    }
  }

  stopPolling(): void {
    if (this.pollingInterval) {
      logger.info('[QuotaService] Stopping polling loop');
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
  }

  async retryFromError(pollingInterval: number): Promise<void> {
    logger.info(`Manual quota retry triggered; restarting full flow (interval ${pollingInterval}ms)...`);

    this.consecutiveErrors = 0;
    this.retryCount = 0;
    this.isRetrying = false;
    this.isFirstAttempt = true;

    this.stopPolling();

    await this.fetchQuota();

    if (this.consecutiveErrors === 0) {
      logger.info('Fetch succeeded, starting polling...');
      this.pollingInterval = setInterval(() => {
        this.fetchQuota();
      }, pollingInterval);
    } else {
      logger.info('Fetch failed, keeping polling stopped');
    }
  }

  async quickRefresh(): Promise<void> {
    logger.info('Triggering immediate quota refresh...');

    await this.doFetchQuota();
  }

  getLastSnapshot(): QuotaSnapshot | undefined {
    return this.lastSnapshot;
  }

  private async fetchQuota(): Promise<void> {
    if (this.isRetrying) {
      logger.info('Currently retrying; skipping this polling run...');
      return;
    }

    await this.doFetchQuota();
  }

  private async doFetchQuota(): Promise<void> {
    logger.info(`Starting quota fetch with method ${this.apiMethod} (firstAttempt=${this.isFirstAttempt})...`);

    if (this.statusCallback && this.isFirstAttempt) {
      this.statusCallback('fetching');
    }

    try {
      
      // Only use Google API for quota fetching
      // Gravity Orchestrator app data is fetched separately via StatusBar.updateDisplayFromApp()
      logger.info('Using Google API (direct)');

      const result = await this.handleGoogleApiQuota();
      if (result === null) {
        return;
      }
      const snapshot: QuotaSnapshot = result;
      this.lastSnapshot = snapshot;

      this.consecutiveErrors = 0;
      this.retryCount = 0;
      this.isFirstAttempt = false;

      if (this.staleCallback) {
        this.staleCallback(false);
      }

      const modelCount = snapshot.models?.length ?? 0;
      logger.info(`[QuotaService] Snapshot ready: models=${modelCount}`);

      if (this.updateCallback) {
        this.updateCallback(snapshot);
      } else {
        logger.warn('updateCallback is not registered');
      }
    } catch (error: any) {
      this.consecutiveErrors++;
      logger.error(`Quota fetch failed (attempt ${this.consecutiveErrors}):`, error.message);
      if (error?.stack) {
        logger.error('Stack:', error.stack);
      }

      if (this.isAuthError(error)) {
        logger.info('Google API: Auth issue detected, stopping polling until login');
        if (this.authStatusCallback) {
          const message = (error?.message || '').toLowerCase();
          const isExpired = message.includes('expired') || message.includes('invalid_grant');
          this.authStatusCallback(true, isExpired);
        }
        this.stopPolling();
        this.isRetrying = false;
        this.retryCount = 0;
        this.isFirstAttempt = false;
        return;
      }

      const isNetworkError = this.isNetworkOrTimeoutError(error);
      if (isNetworkError) {
        logger.info('Google API: Network/timeout error, marking data as stale');
        if (this.staleCallback) {
          this.staleCallback(true);
        }

        this.retryCount = 0;
        this.isFirstAttempt = false;
        return;
      }

      if (this.retryCount < this.MAX_RETRY_COUNT) {
        this.retryCount++;
        this.isRetrying = true;
        logger.info(`Retry ${this.retryCount} scheduled in ${this.RETRY_DELAY_MS / 1000} seconds...`);

        if (this.statusCallback) {
          this.statusCallback('retrying', this.retryCount);
        }

        setTimeout(async () => {
          this.isRetrying = false;
          await this.fetchQuota();
        }, this.RETRY_DELAY_MS);
        return;
      }

      logger.error(`Reached max retry count (${this.MAX_RETRY_COUNT}); stopping polling`);
      this.stopPolling();

      if (this.errorCallback) {
        this.errorCallback(error as Error);
      }
    }
  }

  private isNetworkOrTimeoutError(error: any): boolean {
    const message = (error?.message || '').toLowerCase();
    return (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('econnreset') ||
      message.includes('socket hang up') ||
      error?.code === 'ECONNREFUSED' ||
      error?.code === 'ENOTFOUND' ||
      error?.code === 'ECONNRESET' ||
      error?.code === 'ETIMEDOUT'
    );
  }

  private isAuthError(error: any): boolean {
    if (error instanceof GoogleApiError && error.needsReauth()) {
      return true;
    }
    const message = (error?.message || '').toLowerCase();
    return message.includes('not authenticated') || message.includes('unauthorized') || message.includes('invalid_grant');
  }

  private async handleGoogleApiQuota(): Promise<QuotaSnapshot | null> {
    const authState = this.googleAuthService.getAuthState();

    if (authState.state === AuthState.NOT_AUTHENTICATED) {
      logger.info('Google API: Not authenticated, showing login prompt');
      if (this.authStatusCallback) {
        this.authStatusCallback(true, false);
      }

      this.isFirstAttempt = false;
      return null;
    }

    if (authState.state === AuthState.TOKEN_EXPIRED) {
      logger.info('Google API: Token expired, showing re-auth prompt');
      if (this.authStatusCallback) {
        this.authStatusCallback(true, true);
      }

      this.isFirstAttempt = false;
      return null;
    }

    if (authState.state === AuthState.AUTHENTICATING || authState.state === AuthState.REFRESHING) {
      logger.info('Google API: Authentication in progress, skipping this cycle');

      return null;
    }

    return await this.fetchQuotaViaGoogleApi();
  }

  private async fetchQuotaViaGoogleApi(): Promise<QuotaSnapshot> {
    try {

      const accessToken = await this.googleAuthService.getValidAccessToken();

      let userEmail: string | undefined;
      try {
        const userInfo = await this.googleAuthService.fetchUserInfo(accessToken);
        userEmail = userInfo.email;
        logger.info('Google API: User email:', userEmail);
      } catch (e) {
        logger.warn('Google API: Failed to fetch user info:', e);

        userEmail = this.googleAuthService.getUserEmail();
      }

      logger.info('Google API: Loading project info...');
      const projectInfo = await this.googleApiClient.loadProjectInfo(accessToken);
      logger.info('Google API: Project info loaded:', projectInfo.tier);

      logger.info('Google API: Fetching models quota...');
      const modelsQuota = await this.googleApiClient.fetchModelsQuota(accessToken, projectInfo.projectId);
      logger.info('Google API: Models quota fetched:', modelsQuota.models.length, 'models');

      if (this.authStatusCallback) {
        this.authStatusCallback(false, false);
      }

      const models: ModelQuotaInfo[] = modelsQuota.models.map((model) => {
        const resetTime = new Date(model.resetTime);
        const timeUntilReset = resetTime.getTime() - Date.now();

        return {
          label: model.displayName,
          modelId: model.modelName,
          remainingFraction: model.remainingQuota,
          remainingPercentage: model.remainingQuota * 100,
          isExhausted: model.isExhausted,
          resetTime,
          timeUntilReset,
          timeUntilResetFormatted: formatTimeUntilReset(timeUntilReset),
        };
      });

      return {
        timestamp: new Date(),

        models,
        planName: projectInfo.tier,
        userEmail,
      };
    } catch (error) {
      if (error instanceof GoogleApiError) {
        if (error.needsReauth()) {
          logger.info('Google API: Token invalid, need to re-authenticate');
          if (this.authStatusCallback) {
            this.authStatusCallback(true, true);
          }
        }
      }
      throw error;
    }
  }

  dispose(): void {
    this.stopPolling();
  }
}
