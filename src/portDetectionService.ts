import * as vscode from 'vscode';
import { ProcessPortDetector, AntigravityProcessInfo } from './processPortDetector';
import { logger } from './utils/logger';

export interface PortDetectionResult {

    port: number;
    connectPort: number;

    httpPort: number;
    csrfToken: string;
    source: 'process';
    confidence: 'high';
}

export class PortDetectionService {
    private processDetector: ProcessPortDetector;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.processDetector = new ProcessPortDetector();
    }

    async detectPort(): Promise<PortDetectionResult | null> {

        const processInfo: AntigravityProcessInfo | null = await this.processDetector.detectProcessInfo();

        if (!processInfo) {
            logger.error('[PortDetectionService] Failed to get port and CSRF Token from process.');
            logger.error('[PortDetectionService] Ensure language_server_windows_x64.exe is running.');
            return null;
        }

        logger.info(`[PortDetectionService] Detected Connect port (HTTPS): ${processInfo.connectPort}`);
        logger.info(`[PortDetectionService] Detected extension port (HTTP): ${processInfo.extensionPort}`);
        logger.info(`[PortDetectionService] Detected CSRF Token: ${this.maskToken(processInfo.csrfToken)}`);

        return {

            port: processInfo.connectPort,
            connectPort: processInfo.connectPort,
            httpPort: processInfo.extensionPort,
            csrfToken: processInfo.csrfToken,
            source: 'process',
            confidence: 'high'
        };
    }

    private maskToken(token: string): string {
        if (token.length <= 14) {
            return '***';
        }
        return `${token.substring(0, 6)}***${token.substring(token.length - 4)}`;
    }
}
