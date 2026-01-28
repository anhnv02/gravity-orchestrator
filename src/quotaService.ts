import * as https from "https";
import * as http from "http";
import { UserStatusResponse, QuotaSnapshot, PromptCreditsInfo, ModelQuotaInfo } from "./types";
import { versionInfo } from "./versionInfo";
import { GoogleAuthService, AuthState } from "./auth";
import { GoogleCloudCodeClient, GoogleApiError } from "./api";
import { logger } from "./utils/logger";
import { formatTimeUntilReset } from "./utils/timeUtils";


export enum QuotaApiMethod {

  GET_USER_STATUS = 'GET_USER_STATUS',
  GOOGLE_API = 'GOOGLE_API'
}

interface RequestConfig {
  path: string;
  body: object;
  timeout?: number;
}

async function makeRequest(
  config: RequestConfig,
  port: number,
  httpPort: number | undefined,
  csrfToken: string | undefined
): Promise<any> {
  const requestBody = JSON.stringify(config.body);

  const headers: Record<string, string | number> = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(requestBody),
    'Connect-Protocol-Version': '1'
  };

  if (csrfToken) {
    headers['X-Codeium-Csrf-Token'] = csrfToken;
  } else {
    throw new Error('Missing CSRF token');
  }

  const doRequest = (useHttps: boolean, targetPort: number) => new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname: '127.0.0.1',
      port: targetPort,
      path: config.path,
      method: 'POST',
      headers,
      rejectUnauthorized: false,
      timeout: config.timeout ?? 5000
    };

    logger.info(`Request URL: ${useHttps ? 'https' : 'http'}://127.0.0.1:${targetPort}${config.path}`);

    const client = useHttps ? https : http;
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          let errorDetail = '';
          try {
            const errorBody = JSON.parse(data);
            errorDetail = errorBody.message || errorBody.error || JSON.stringify(errorBody);
          } catch {
            errorDetail = data || '(empty response)';
          }
          reject(new Error(`HTTP error: ${res.statusCode}, detail: ${errorDetail}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error(`Failed to parse response: ${error}`));
        }
      });
    });

    req.on('error', (error) => reject(error));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(requestBody);
    req.end();
  });

  try {
    return await doRequest(true, port);
  } catch (error: any) {
    const msg = (error?.message || '').toLowerCase();
    const shouldRetryHttp = httpPort !== undefined && (error.code === 'EPROTO' || msg.includes('wrong_version_number'));
    if (shouldRetryHttp) {
      logger.warn('HTTPS failed; trying HTTP fallback port:', httpPort);
      return await doRequest(false, httpPort);
    }
    throw error;
  }
}

export class QuotaService {
  private readonly GET_USER_STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';

  private readonly MAX_RETRY_COUNT = 3;
  private readonly RETRY_DELAY_MS = 5000;

  private port: number;

  private httpPort?: number;
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
  private csrfToken?: string;
  private googleAuthService: GoogleAuthService;
  private googleApiClient: GoogleCloudCodeClient;
  private apiMethod: QuotaApiMethod = QuotaApiMethod.GET_USER_STATUS;

  constructor(port: number, csrfToken?: string, httpPort?: number) {
    this.port = port;
    this.httpPort = httpPort ?? port;
    this.csrfToken = csrfToken;
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

  setAuthInfo(_unused?: any, csrfToken?: string): void {
    this.csrfToken = csrfToken;
  }


  setPorts(connectPort: number, httpPort?: number): void {
    this.port = connectPort;
    this.httpPort = httpPort ?? connectPort;
    this.consecutiveErrors = 0;
    this.retryCount = 0;
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

      let snapshot: QuotaSnapshot;
      switch (this.apiMethod) {
        case QuotaApiMethod.GOOGLE_API: {
          logger.info('Using Google API (direct)');

          const result = await this.handleGoogleApiQuota();
          if (result === null) {

            return;
          }
          snapshot = result;
          break;
        }
        case QuotaApiMethod.GET_USER_STATUS: {
          logger.info('Using GetUserStatus API');
          const userStatusResponse = await this.makeGetUserStatusRequest();
          const invalid1 = this.getInvalidCodeInfo(userStatusResponse);
          if (invalid1) {
            logger.error('Response code invalid; will treat as error', invalid1);
            const detail = invalid1.message ? `: ${invalid1.message}` : '';
            const err = new Error(`Invalid response code ${invalid1.code}${detail}`);
            err.name = 'QuotaInvalidCodeError';
            throw err;
          }
          snapshot = this.parseGetUserStatusResponse(userStatusResponse);
          break;
        }

        default: {

          logger.info('Falling back to GetUserStatus API');
          const userStatusResponse = await this.makeGetUserStatusRequest();
          const invalid1 = this.getInvalidCodeInfo(userStatusResponse);
          if (invalid1) {
            logger.error('Response code invalid; will treat as error', invalid1);
            const detail = invalid1.message ? `: ${invalid1.message}` : '';
            const err = new Error(`Invalid response code ${invalid1.code}${detail}`);
            err.name = 'QuotaInvalidCodeError';
            throw err;
          }
          snapshot = this.parseGetUserStatusResponse(userStatusResponse);
          break;
        }
      }

      this.consecutiveErrors = 0;
      this.retryCount = 0;
      this.isFirstAttempt = false;

      if (this.apiMethod === QuotaApiMethod.GOOGLE_API && this.staleCallback) {
        this.staleCallback(false);
      }

      const modelCount = snapshot.models?.length ?? 0;
      const hasPromptCredits = Boolean(snapshot.promptCredits);
      logger.info(`[QuotaService] Snapshot ready: models=${modelCount}, promptCredits=${hasPromptCredits}`);

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

      if (this.apiMethod === QuotaApiMethod.GOOGLE_API && this.isAuthError(error)) {
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

      if (this.apiMethod === QuotaApiMethod.GOOGLE_API) {
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

  private async makeGetUserStatusRequest(): Promise<any> {
    logger.info('Using CSRF token:', this.csrfToken ? '[present]' : '[missing]');
    return makeRequest(
      {
        path: this.GET_USER_STATUS_PATH,
        body: {
          metadata: {
            ideName: 'antigravity',
            extensionName: 'antigravity',
            ideVersion: versionInfo.getIdeVersion(),
            locale: 'en'
          }
        }
      },
      this.port,
      this.httpPort,
      this.csrfToken
    );
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
        promptCredits: undefined,
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

  private parseGetUserStatusResponse(response: UserStatusResponse): QuotaSnapshot {
    if (!response || !response.userStatus) {
      throw new Error('API response format is invalid; missing userStatus');
    }

    const userStatus = response.userStatus;
    const planStatus = userStatus.planStatus;
    const modelConfigs = userStatus.cascadeModelConfigData?.clientModelConfigs || [];

    const monthlyCreditsRaw = planStatus?.planInfo?.monthlyPromptCredits;
    const availableCreditsRaw = planStatus?.availablePromptCredits;

    const monthlyCredits = monthlyCreditsRaw !== undefined ? Number(monthlyCreditsRaw) : undefined;
    const availableCredits = availableCreditsRaw !== undefined ? Number(availableCreditsRaw) : undefined;

    const promptCredits: PromptCreditsInfo | undefined =
      planStatus && monthlyCredits !== undefined && monthlyCredits > 0 && availableCredits !== undefined
        ? {
          available: availableCredits,
          monthly: monthlyCredits,
          usedPercentage: ((monthlyCredits - availableCredits) / monthlyCredits) * 100,
          remainingPercentage: (availableCredits / monthlyCredits) * 100
        }
        : undefined;

    const models: ModelQuotaInfo[] = modelConfigs
      .filter(config => config.quotaInfo)
      .filter(config => !config.label.toLowerCase().includes('image'))
      .map(config => this.parseModelQuota(config));

    const planName = userStatus?.userTier?.name;

    return {
      timestamp: new Date(),
      promptCredits,
      models,
      planName
    };
  }

  private parseModelQuota(config: any): ModelQuotaInfo {
    const quotaInfo = config.quotaInfo;
    const remainingFraction = quotaInfo?.remainingFraction;
    const resetTime = new Date(quotaInfo.resetTime);
    const timeUntilReset = resetTime.getTime() - Date.now();

    logger.info(`[QuotaService] Model ${config.label}: resetTime=${quotaInfo.resetTime}, timeUntilReset=${timeUntilReset}ms (${timeUntilReset <= 0 ? 'EXPIRED' : 'valid'})`);

    return {
      label: config.label,
      modelId: config.modelOrAlias.model,
      remainingFraction,
      remainingPercentage: remainingFraction !== undefined ? remainingFraction * 100 : undefined,
      isExhausted: remainingFraction === undefined || remainingFraction === 0,
      resetTime,
      timeUntilReset,
      timeUntilResetFormatted: formatTimeUntilReset(timeUntilReset)
    };
  }


  private getInvalidCodeInfo(response: any): { code: any; message?: any } | null {
    const code = response?.code;
    if (code === undefined || code === null) {
      return null;
    }

    const okValues = [0, '0', 'OK', 'Ok', 'ok', 'success', 'SUCCESS'];
    if (okValues.includes(code)) {
      return null;
    }

    return { code, message: response?.message };
  }

  dispose(): void {
    this.stopPolling();
  }
}
