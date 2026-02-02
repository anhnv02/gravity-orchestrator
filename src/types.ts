

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
