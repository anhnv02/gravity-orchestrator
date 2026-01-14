declare const process: any;
import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { IPlatformStrategy } from './platformDetector';
import { LocalizationService } from './i18n/localizationService';
import { logger } from './utils/logger';

const execAsync = promisify(exec);

export class UnixProcessDetector implements IPlatformStrategy {
    private platform: NodeJS.Platform;

    private availablePortCommand: 'lsof' | 'ss' | 'netstat' | null = null;

    constructor(platform: NodeJS.Platform) {
        this.platform = platform;
    }

    private async commandExists(command: string): Promise<boolean> {
        try {
            await execAsync(`which ${command}`, { timeout: 3000 });
            return true;
        } catch {
            return false;
        }
    }

    async ensurePortCommandAvailable(): Promise<void> {

        if (this.availablePortCommand) {
            return;
        }

        const commands = ['lsof', 'ss', 'netstat'] as const;
        const available: string[] = [];

        for (const cmd of commands) {
            if (await this.commandExists(cmd)) {
                available.push(cmd);
                if (!this.availablePortCommand) {
                    this.availablePortCommand = cmd;
                }
            }
        }

        logger.info(`[UnixProcessDetector] Port command check: available=[${available.join(', ') || 'none'}], using=${this.availablePortCommand || 'none'}`);

        if (!this.availablePortCommand) {
            const localizationService = LocalizationService.getInstance();
            const message = this.platform === 'darwin'
                ? localizationService.t('notify.portCommandRequiredDarwin')
                : localizationService.t('notify.portCommandRequired');

            vscode.window.showErrorMessage(message, { modal: false });
            throw new Error('No port detection command available (lsof/ss/netstat)');
        }
    }

    private isAntigravityProcess(commandLine: string): boolean {
        const lowerCmd = commandLine.toLowerCase();

        if (/--app_data_dir\s+antigravity\b/i.test(commandLine)) {
            return true;
        }

        if (lowerCmd.includes('/antigravity/') || lowerCmd.includes('\\antigravity\\')) {
            return true;
        }
        return false;
    }

    /**
     * Get command to list Unix processes using ps and grep.
     */
    getProcessListCommand(processName: string): string {
        // Use ps -ww -eo pid,ppid,args to get PID, PPID and full command line
        // -ww: unlimited width (avoid truncation)
        // -e: select all processes
        // -o: user-defined format
        // grep -v graftcp: exclude graftcp wrapper processes (users may use graftcp to proxy language_server)
        return `ps -ww -eo pid,ppid,args | grep "${processName}" | grep -v grep | grep -v graftcp`;
    }

    parseProcessInfo(stdout: string): {
        pid: number;
        extensionPort: number;
        csrfToken: string;
    } | null {
        if (!stdout || stdout.trim().length === 0) {
            return null;
        }

        const lines = stdout.trim().split('\n');
        const currentPid = process.pid;
        const candidates: Array<{ pid: number; ppid: number; extensionPort: number; csrfToken: string }> = [];

        for (const line of lines) {
            // Format: PID PPID COMMAND...
            const parts = line.trim().split(/\s+/);
            if (parts.length < 3) {
                continue;
            }

            const pid = parseInt(parts[0], 10);
            const ppid = parseInt(parts[1], 10);

            // Reconstruct command line (it might contain spaces)
            const cmd = parts.slice(2).join(' ');

            if (isNaN(pid) || isNaN(ppid)) {
                continue;
            }

            // Kiểm tra phòng thủ: Bỏ qua tiến trình wrapper graftcp
            // graftcp là công cụ dùng để proxy language_server, bản thân nó không lắng nghe cổng
            // Định dạng dòng lệnh như: /opt/graftcp/graftcp /path/to/language_server_linux_x64.bak ...
            const executable = parts[2]; // Phần đầu của dòng lệnh (file thực thi)
            if (executable.includes('graftcp')) {
                continue;
            }

            const portMatch = cmd.match(/--extension_server_port[=\s]+(\d+)/);
            const tokenMatch = cmd.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);

            // Phải đồng thời thỏa mãn: Có csrf_token và là tiến trình Antigravity
            if (tokenMatch && tokenMatch[1] && this.isAntigravityProcess(cmd)) {
                const extensionPort = portMatch && portMatch[1] ? parseInt(portMatch[1], 10) : 0;
                const csrfToken = tokenMatch[1];
                candidates.push({ pid, ppid, extensionPort, csrfToken });
            }
        }

        if (candidates.length === 0) {
            return null;
        }

        // 1. Prefer the process that is a direct child of the current process (extension host)
        const child = candidates.find(c => c.ppid === currentPid);
        if (child) {
            return child;
        }

        // 2. Fallback: return the first candidate found (legacy behavior)
        // This handles cases where the process hierarchy might be different (e.g. intermediate shell)
        return candidates[0];
    }

    /**
     * Get command to list ports for a specific process.
     * Uses the available command detected by ensurePortCommandAvailable().
     */
    getPortListCommand(pid: number): string {
        switch (this.availablePortCommand) {
            case 'lsof':
                // lsof: -P no port name resolution, -a AND conditions, -n no hostname resolution
                return `lsof -Pan -p ${pid} -i`;
            case 'ss':
                // ss: -t TCP, -l listening, -n numeric, -p show process
                return `ss -tlnp 2>/dev/null | grep "pid=${pid},"`;
            case 'netstat':
                return `netstat -tulpn 2>/dev/null | grep ${pid}`;
            default:
                // Fallback chain if ensurePortCommandAvailable() wasn't called
                return `lsof -Pan -p ${pid} -i 2>/dev/null || ss -tlnp 2>/dev/null | grep "pid=${pid}," || netstat -tulpn 2>/dev/null | grep ${pid}`;
        }
    }

    parseListeningPorts(stdout: string): number[] {
        const ports: number[] = [];

        if (!stdout || stdout.trim().length === 0) {
            return ports;
        }

        const lines = stdout.trim().split('\n');

        for (const line of lines) {

            const lsofMatch = line.match(/127\.0\.0\.1:(\d+).*\(LISTEN\)/);
            if (lsofMatch && lsofMatch[1]) {
                const port = parseInt(lsofMatch[1], 10);
                if (!ports.includes(port)) {
                    ports.push(port);
                }
                continue;
            }

            const ssMatch = line.match(/LISTEN\s+\d+\s+\d+\s+(?:127\.0\.0\.1|\*):(\d+)/);
            if (ssMatch && ssMatch[1]) {
                const port = parseInt(ssMatch[1], 10);
                if (!ports.includes(port)) {
                    ports.push(port);
                }
                continue;
            }

            const netstatMatch = line.match(/127\.0\.0\.1:(\d+).*LISTEN/);
            if (netstatMatch && netstatMatch[1]) {
                const port = parseInt(netstatMatch[1], 10);
                if (!ports.includes(port)) {
                    ports.push(port);
                }
                continue;
            }

            const localhostMatch = line.match(/localhost:(\d+).*\(LISTEN\)|localhost:(\d+).*LISTEN/);
            if (localhostMatch) {
                const port = parseInt(localhostMatch[1] || localhostMatch[2], 10);
                if (!ports.includes(port)) {
                    ports.push(port);
                }
            }
        }

        return ports.sort((a, b) => a - b);
    }

    getErrorMessages(): {
        processNotFound: string;
        commandNotAvailable: string;
        requirements: string[];
    } {
        const processName = this.platform === 'darwin'
            ? 'language_server_macos'
            : 'language_server_linux';

        return {
            processNotFound: 'language_server process not found',
            commandNotAvailable: 'ps/lsof commands are unavailable; please check the system environment',
            requirements: [
                'Antigravity is running',
                `${processName} process is running`,
                'The system has permission to execute ps and lsof commands'
            ]
        };
    }
}
