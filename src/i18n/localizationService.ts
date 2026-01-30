import { TranslationKey, TranslationMap } from './types';
import { en } from './en';

export class LocalizationService {
    private static instance: LocalizationService;
    private currentLocale: TranslationMap = en;

    private constructor() {
    }

    public static getInstance(): LocalizationService {
        if (!LocalizationService.instance) {
            LocalizationService.instance = new LocalizationService();
        }
        return LocalizationService.instance;
    }

    public t(key: TranslationKey, params?: { [key: string]: string | number }): string {
        let text = this.currentLocale[key] || en[key] || key;

        if (params) {
            Object.keys(params).forEach(param => {
                text = text.replace(`{${param}}`, String(params[param]));
            });
        }

        return text;
    }
}
