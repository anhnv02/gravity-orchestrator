import { exec } from 'child_process';
import { promisify } from 'util';
import * as https from 'https';
import { PlatformDetector, IPlatformStrategy } from './platformDetector';
import { versionInfo } from './versionInfo';
import { logger } from './utils/logger';

const execAsync = promisify(exec);

export interface AntigravityProcessInfo {

  extensionPort: number;

  connectPort: number;
  csrfToken: string;
}

export class ProcessPortDetector {
  private platformDetector: PlatformDetector;
  private platformStrategy: IPlatformStrategy;
  private processName: string;

  constructor() {
    this.platformDetector = new PlatformDetector();
    this.platformStrategy = this.platformDetector.getStrategy();
    this.processName = this.platformDetector.getProcessName();
  }

  async detectProcessInfo(maxRetries: number = 3, retryDelay: number = 2000): Promise<AntigravityProcessInfo | null> {
    const platformName = this.platformDetector.getPlatformName();
    const errorMessages = this.platformStrategy.getErrorMessages();

    if (platformName === 'Windows') {
      const windowsStrategy = this.platformStrategy as any;
      const mode = windowsStrategy.isUsingPowerShell?.() ? 'PowerShell' : 'WMIC';
      logger.info(`[PortDetector] Windows detection mode: ${mode}`);
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`[PortDetector] Attempting to detect Antigravity process (${platformName}, try ${attempt}/${maxRetries})...`);

        const command = this.platformStrategy.getProcessListCommand(this.processName);
        logger.info(`[PortDetector] Running process list command: ${command}`);
        const { stdout } = await execAsync(command, { timeout: 15000 });
        const preview = stdout.trim().split('\n').slice(0, 3).join('\n');
        logger.info(`[PortDetector] Process command output preview:\n${preview || '(empty)'}`);

        const processInfo = this.platformStrategy.parseProcessInfo(stdout);

        if (!processInfo) {
          logger.warn(`[PortDetector] Attempt ${attempt}: ${errorMessages.processNotFound}`);
          throw new Error(errorMessages.processNotFound);
        }

        const { pid, extensionPort, csrfToken } = processInfo;

        logger.info('[PortDetector] Found process info:');
        logger.info(`[PortDetector]   PID: ${pid}`);
        logger.info(`[PortDetector]   extension_server_port: ${extensionPort || '(not found)'}`);
        logger.info(`[PortDetector]   CSRF Token: ${csrfToken ? '[present]' : '[missing]'}`);

        logger.info(`[PortDetector] Fetching listening ports for PID ${pid}...`);
        const listeningPorts = await this.getProcessListeningPorts(pid);

        if (listeningPorts.length === 0) {
          logger.warn(`[PortDetector] Attempt ${attempt}: process is not listening on any ports`);
          throw new Error('Process is not listening on any ports');
        }

        logger.info(`[PortDetector] Found ${listeningPorts.length} listening ports: ${listeningPorts.join(', ')}`);

        logger.info('[PortDetector] Testing port connectivity...');
        const connectPort = await this.findWorkingPort(listeningPorts, csrfToken);

        if (!connectPort) {
          logger.warn(`[PortDetector] Attempt ${attempt}: all port tests failed`);
          throw new Error('Unable to find a working API port');
        }

        logger.info(`[PortDetector] Attempt ${attempt} succeeded`);
        logger.info(`[PortDetector] API port (HTTPS): ${connectPort}`);
        logger.info(`[PortDetector] Detection summary: extension_port=${extensionPort}, connect_port=${connectPort}`);

        return { extensionPort, connectPort, csrfToken };

      } catch (error: any) {
        const errorMsg = error?.message || String(error);
        logger.error(`[PortDetector] Attempt ${attempt} failed:`, errorMsg);
        if (error?.stack) {
          logger.error('[PortDetector]   Stack:', error.stack);
        }

        if (errorMsg.includes('timeout')) {
          logger.error('[PortDetector]   Reason: command execution timed out; the system may be under heavy load');
        } else if (errorMsg.includes('not found') || errorMsg.includes('not recognized') || errorMsg.includes('not recognized as an internal or external command')) {
          logger.error(`[PortDetector]   Reason: ${errorMessages.commandNotAvailable}`);

          if (this.platformDetector.getPlatformName() === 'Windows') {
            const windowsStrategy = this.platformStrategy as any;
            if (windowsStrategy.setUsePowerShell && !windowsStrategy.isUsingPowerShell()) {
              logger.warn('[PortDetector] WMIC command is unavailable (Windows 10 21H1+/Windows 11 deprecated WMIC)');
              logger.info('[PortDetector] Switching to PowerShell mode and retrying...');
              windowsStrategy.setUsePowerShell(true);

              attempt--;
              continue;
            }
          }
        }
      }

      if (attempt < maxRetries) {
        logger.info(`[PortDetector] Waiting ${retryDelay}ms before retrying...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    logger.error(`[PortDetector] All ${maxRetries} attempts failed`);
    logger.error('[PortDetector] Please ensure:');
    errorMessages.requirements.forEach((req, index) => {
      logger.error(`[PortDetector]   ${index + 1}. ${req}`);
    });

    return null;
  }

  private async getProcessListeningPorts(pid: number): Promise<number[]> {
    try {

      await this.platformStrategy.ensurePortCommandAvailable();

      const command = this.platformStrategy.getPortListCommand(pid);
      logger.info(`[PortDetector] Running port list command for PID ${pid}: ${command}`);
      const { stdout } = await execAsync(command, { timeout: 3000 });
      logger.info(`[PortDetector] Port list output preview:\n${stdout.trim().split('\n').slice(0, 5).join('\n') || '(empty)'}`);

      const ports = this.platformStrategy.parseListeningPorts(stdout);
      logger.info(`[PortDetector] Parsed listening ports: ${ports.length > 0 ? ports.join(', ') : '(none)'}`);
      return ports;
    } catch (error) {
      logger.error('Failed to fetch listening ports:', error);
      return [];
    }
  }

  private async findWorkingPort(ports: number[], csrfToken: string): Promise<number | null> {
    logger.info(`[PortDetector] Candidate ports for testing: ${ports.join(', ') || '(none)'}`);
    for (const port of ports) {
      logger.info(`[PortDetector]   Testing port ${port}...`);
      const isWorking = await this.testPortConnectivity(port, csrfToken);
      if (isWorking) {
        logger.info(`[PortDetector]   Port ${port} test succeeded`);
        return port;
      } else {
        logger.info(`[PortDetector]   Port ${port} test failed`);
      }
    }
    return null;
  }

  private async testPortConnectivity(port: number, csrfToken: string): Promise<boolean> {
    return new Promise((resolve) => {
      const requestBody = JSON.stringify({
        context: {
          properties: {
            devMode: "false",
            extensionVersion: versionInfo.getExtensionVersion(),
            hasAnthropicModelAccess: "true",
            ide: "antigravity",
            ideVersion: versionInfo.getIdeVersion(),
            installationId: "test-detection",
            language: "UNSPECIFIED",
            os: versionInfo.getOs(),
            requestedModelId: "MODEL_UNSPECIFIED"
          }
        }
      });

      const options = {
        hostname: '127.0.0.1',
        port: port,
        path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          'Connect-Protocol-Version': '1',
          'X-Codeium-Csrf-Token': csrfToken
        },
        rejectUnauthorized: false,
        timeout: 2000
      };

      logger.info(`[PortDetector] Sending GetUnleashData probe to port ${port}`);
      const req = https.request(options, (res) => {
        const success = res.statusCode === 200;
        logger.info(`[PortDetector] Port ${port} responded with status ${res.statusCode}`);
        res.resume();
        resolve(success);
      });

      req.on('error', (err) => {
        logger.warn(`[PortDetector] Port ${port} connectivity error: ${err.message}`);
        resolve(false);
      });

      req.on('timeout', () => {
        logger.warn(`[PortDetector] Port ${port} probe timed out`);
        req.destroy();
        resolve(false);
      });

      req.write(requestBody);
      req.end();
    });
  }
}
