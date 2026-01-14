export const GOOGLE_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';

export const GOOGLE_CLIENT_SECRET = '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';

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export const GOOGLE_SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs'
].join(' ');

export const TOKEN_STORAGE_KEY = 'gravity-orchestrator.google-oauth-token';

export const CLOUD_CODE_API_BASE = 'https://cloudcode-pa.googleapis.com';
export const LOAD_CODE_ASSIST_PATH = '/v1internal:loadCodeAssist';
export const FETCH_AVAILABLE_MODELS_PATH = '/v1internal:fetchAvailableModels';

export const CALLBACK_HOST = '127.0.0.1';
export const CALLBACK_PATH = '/callback';

export const AUTH_TIMEOUT_MS = 60000;
export const API_TIMEOUT_MS = 10000;

export const MAX_RETRIES = 3;
export const RETRY_DELAY_MS = 1000;
