import * as https from 'https';
import { logger } from '../utils/logger';
import {
    CLOUD_CODE_API_BASE,
    LOAD_CODE_ASSIST_PATH,
    FETCH_AVAILABLE_MODELS_PATH,
    API_TIMEOUT_MS,
    MAX_RETRIES,
    RETRY_DELAY_MS,
} from '../auth/constants';

export interface ProjectInfo {
    projectId: string;
    tier: string;
}

export interface ModelQuotaFromApi {
    modelName: string;
    displayName: string;
    remainingQuota: number;
    resetTime: string;
    isExhausted: boolean;
}

export interface ModelsQuotaResponse {
    models: ModelQuotaFromApi[];
}

export class GoogleApiError extends Error {
    constructor(
        message: string,
        public statusCode: number,
        public errorCode?: string
    ) {
        super(message);
        this.name = 'GoogleApiError';
    }

    public isRetryable(): boolean {

        return this.statusCode >= 500 || this.statusCode === 429;
    }

    public needsReauth(): boolean {
        return this.statusCode === 401;
    }
}

export class GoogleCloudCodeClient {
    private static instance: GoogleCloudCodeClient;

    private constructor() { }

    public static getInstance(): GoogleCloudCodeClient {
        if (!GoogleCloudCodeClient.instance) {
            GoogleCloudCodeClient.instance = new GoogleCloudCodeClient();
        }
        return GoogleCloudCodeClient.instance;
    }

    public async loadProjectInfo(accessToken: string): Promise<ProjectInfo> {
        logger.info('[GoogleAPI] loadProjectInfo: Sending request...');
        const requestBody = {
            metadata: {
                ideType: 'ANTIGRAVITY'
            }
        };
        logger.info('[GoogleAPI] loadProjectInfo: Request body:', JSON.stringify(requestBody));

        const response = await this.makeApiRequest(
            LOAD_CODE_ASSIST_PATH,
            accessToken,
            requestBody
        );

        logger.info('[GoogleAPI] loadProjectInfo: Raw response:', JSON.stringify(response));

        const paidTier = response.paidTier || {};
        const currentTier = response.currentTier || {};
        const tier = paidTier.id || currentTier.id || 'FREE';

        const result = {
            projectId: response.cloudaicompanionProject || '',
            tier: tier,
        };
        logger.info('[GoogleAPI] loadProjectInfo: Parsed result:', JSON.stringify(result));

        return result;
    }

    public async fetchModelsQuota(
        accessToken: string,
        projectId?: string
    ): Promise<ModelsQuotaResponse> {

        const body: any = {
            project: projectId || 'bamboo-precept-lgxtn'
        };
        logger.info('[GoogleAPI] fetchModelsQuota: Request body:', JSON.stringify(body));

        const response = await this.makeApiRequest(
            FETCH_AVAILABLE_MODELS_PATH,
            accessToken,
            body
        );

        const modelsMap = response.models || {};
        const modelNames = Object.keys(modelsMap);
        logger.info('[GoogleAPI] fetchModelsQuota: Found models:', modelNames.join(', '));

        const models: ModelQuotaFromApi[] = [];

        const allowedModelPatterns = /gemini|claude|gpt/i;

        for (const [modelName, modelInfo] of Object.entries(modelsMap)) {

            if (!allowedModelPatterns.test(modelName)) {
                logger.info(`[GoogleAPI] fetchModelsQuota: Model "${modelName}" filtered out (not gemini/claude/gpt)`);
                continue;
            }

            if (!this.isModelVersionSupported(modelName)) {
                logger.info(`[GoogleAPI] fetchModelsQuota: Model "${modelName}" filtered out (Gemini version < 3.0)`);
                continue;
            }

            if (modelName.toLowerCase().includes('image')) {
                logger.info(`[GoogleAPI] fetchModelsQuota: Model "${modelName}" filtered out (Image model)`);
                continue;
            }

            const info = modelInfo as any;
            if (info.quotaInfo) {
                const parsed = this.parseModelQuota(modelName, info);
                logger.info(`[GoogleAPI] fetchModelsQuota: Model "${modelName}" -> remaining: ${parsed.remainingQuota * 100}%`);
                models.push(parsed);
            } else {
                logger.info(`[GoogleAPI] fetchModelsQuota: Model "${modelName}" has no quotaInfo, skipping`);
            }
        }

        logger.info('[GoogleAPI] fetchModelsQuota: Total models with quota:', models.length);
        return { models };
    }

    private parseModelQuota(modelName: string, modelInfo: any): ModelQuotaFromApi {
        const quotaInfo = modelInfo.quotaInfo || {};

        const remainingFraction = quotaInfo.remainingFraction ?? 0;

        const displayName = this.formatModelDisplayName(modelName);

        return {
            modelName: modelName,
            displayName: displayName,
            remainingQuota: typeof remainingFraction === 'number' ? remainingFraction : 0,
            resetTime: quotaInfo.resetTime || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            isExhausted: remainingFraction <= 0,
        };
    }

    private formatModelDisplayName(modelName: string): string {

        const fixedModelName = modelName.replace(/(\d+)-(\d+)/g, '$1.$2');

        return fixedModelName
            .split('-')
            .map(part => {

                if (/^\d/.test(part)) {
                    return part;
                }

                return part.charAt(0).toUpperCase() + part.slice(1);
            })
            .join(' ');
    }

    private async makeApiRequest(
        path: string,
        accessToken: string,
        body: object
    ): Promise<any> {
        let lastError: Error | null = null;
        logger.info(`[GoogleAPI] makeApiRequest: ${path} (max retries: ${MAX_RETRIES})`);

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                logger.info(`[GoogleAPI] makeApiRequest: Attempt ${attempt + 1}/${MAX_RETRIES}`);
                return await this.doRequest(path, accessToken, body);
            } catch (e) {
                lastError = e as Error;
                logger.error(`[GoogleAPI] makeApiRequest: Attempt ${attempt + 1} failed:`, lastError.message);

                if (e instanceof GoogleApiError) {
                    logger.info(`[GoogleAPI] makeApiRequest: GoogleApiError - status: ${e.statusCode}, retryable: ${e.isRetryable()}, needsReauth: ${e.needsReauth()}`);

                    if (!e.isRetryable()) {
                        logger.info('[GoogleAPI] makeApiRequest: Error is not retryable, throwing');
                        throw e;
                    }

                    if (e.needsReauth()) {
                        logger.info('[GoogleAPI] makeApiRequest: Needs re-auth, throwing');
                        throw e;
                    }
                }

                if (attempt < MAX_RETRIES - 1) {
                    const delay = RETRY_DELAY_MS * (attempt + 1);
                    logger.info(`[GoogleAPI] makeApiRequest: Waiting ${delay}ms before retry...`);
                    await this.delay(delay);
                }
            }
        }

        logger.error('[GoogleAPI] makeApiRequest: All retries exhausted');
        throw lastError || new Error('Request failed after retries');
    }

    private doRequest(
        path: string,
        accessToken: string,
        body: object
    ): Promise<any> {
        return new Promise((resolve, reject) => {
            const url = new URL(CLOUD_CODE_API_BASE);
            const postData = JSON.stringify(body);

            logger.info(`[GoogleAPI] doRequest: POST ${url.hostname}${path}`);
            logger.info(`[GoogleAPI] doRequest: Body length: ${postData.length} bytes`);
            logger.info(`[GoogleAPI] doRequest: Token: ${this.maskToken(accessToken)}`);

            const options: https.RequestOptions = {
                hostname: url.hostname,
                port: 443,
                path: path,
                method: 'POST',
                timeout: API_TIMEOUT_MS,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'Authorization': `Bearer ${accessToken}`,
                    'User-Agent': 'AntigravityQuotaWatcher/1.0',
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                logger.info(`[GoogleAPI] doRequest: Response status: ${res.statusCode}`);

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    logger.info(`[GoogleAPI] doRequest: Response body length: ${data.length} bytes`);

                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const response = JSON.parse(data);
                            logger.info('[GoogleAPI] doRequest: Success');
                            resolve(response);
                        } catch (e) {
                            logger.error('[GoogleAPI] doRequest: Failed to parse JSON response');
                            reject(new Error(`Failed to parse API response: ${data}`));
                        }
                    } else {

                        let errorMessage = `API request failed with status ${res.statusCode}`;
                        let errorCode: string | undefined;

                        try {
                            const errorResponse = JSON.parse(data);
                            errorMessage = errorResponse.error?.message || errorResponse.message || errorMessage;
                            errorCode = errorResponse.error?.code || errorResponse.code;
                            logger.error(`[GoogleAPI] doRequest: Error response:`, JSON.stringify(errorResponse));
                        } catch {
                            logger.error(`[GoogleAPI] doRequest: Raw error response: ${data}`);
                        }

                        reject(new GoogleApiError(
                            errorMessage,
                            res.statusCode || 500,
                            errorCode
                        ));
                    }
                });
            });

            req.on('error', (e) => {
                logger.error(`[GoogleAPI] doRequest: Network error: ${e.message}`);
                reject(new Error(`Network error: ${e.message}`));
            });

            req.on('timeout', () => {
                logger.error(`[GoogleAPI] doRequest: Request timeout after ${API_TIMEOUT_MS}ms`);
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.write(postData);
            req.end();
        });
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private maskToken(token: string): string {
        if (token.length <= 14) {
            return '***';
        }
        return `${token.substring(0, 6)}***${token.substring(token.length - 4)}`;
    }

    private isModelVersionSupported(modelName: string): boolean {
        const lowerName = modelName.toLowerCase();

        if (!lowerName.includes('gemini')) {
            return true;
        }

        const versionMatch = lowerName.match(/gemini-(\d+(?:\.\d+)?)/);

        if (versionMatch && versionMatch[1]) {
            const version = parseFloat(versionMatch[1]);

            return version >= 3.0;
        }

        return false;
    }
}
