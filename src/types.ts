export interface ModelConfig {
  label: string;
  modelOrAlias: {
    model: string;
  };
  quotaInfo?: {
    remainingFraction?: number;
    resetTime: string;
  };
  supportsImages?: boolean;
  isRecommended?: boolean;
  allowedTiers?: string[];
}

export interface UserStatusResponse {
  userStatus: {
    name: string;
    email: string;
    planStatus?: {
      planInfo: {
        teamsTier: string;
        planName: string;
        monthlyPromptCredits: number;
        monthlyFlowCredits: number;
      };
      availablePromptCredits: number;
      availableFlowCredits: number;
    };
    cascadeModelConfigData?: {
      clientModelConfigs: ModelConfig[];
    };

    userTier?: {
      id: string;
      name: string;
      description: string;
    };
  };
}

export interface PromptCreditsInfo {
  available: number;
  monthly: number;
  usedPercentage: number;
  remainingPercentage: number;
}

export interface ModelQuotaInfo {
  label: string;
  modelId: string;
  remainingFraction?: number;
  remainingPercentage?: number;
  isExhausted: boolean;
  resetTime: Date;
  timeUntilReset: number;
  timeUntilResetFormatted: string;
}

export interface QuotaSnapshot {
  timestamp: Date;
  promptCredits?: PromptCreditsInfo;
  models: ModelQuotaInfo[];
  planName?: string;
  userEmail?: string;
  isStale?: boolean;
}

export enum QuotaLevel {
  Normal = 'normal',
  Warning = 'warning',
  Critical = 'critical',
  Depleted = 'depleted'
}

export type ApiMethodPreference = 'GOOGLE_API';

export interface Config {
  enabled: boolean;
  pollingInterval: number;
  apiMethod: ApiMethodPreference;
  autoSwitchAccount: boolean;
  switchThreshold: number;
}
