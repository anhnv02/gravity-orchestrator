import { IPlatformStrategy } from './platformDetector';
import { SafePowerShellPath } from './safePowerShellPath';
import { logger } from './utils/logger';

export class WindowsProcessDetector implements IPlatformStrategy {
    private static readonly SYSTEM_ROOT: string = process.env.SystemRoot || 'C:\\Windows';
    private static readonly WMIC_PATH: string = `"${WindowsProcessDetector.SYSTEM_ROOT}\\System32\\wbem\\wmic.exe"`;
    private static readonly NETSTAT_PATH: string = `"${WindowsProcessDetector.SYSTEM_ROOT}\\System32\\netstat.exe"`;
    private static readonly FINDSTR_PATH: string = `"${WindowsProcessDetector.SYSTEM_ROOT}\\System32\\findstr.exe"`;

    private usePowerShell: boolean = true;

    setUsePowerShell(value: boolean): void {
        this.usePowerShell = value;
    }

    isUsingPowerShell(): boolean {
        return this.usePowerShell;
    }

    getProcessListCommand(processName: string): string {
        if (this.usePowerShell) {

            const psPath = SafePowerShellPath.getSafePath();
            return `${psPath} -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='${processName}'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;
        } else {

            return `${WindowsProcessDetector.WMIC_PATH} process where "name='${processName}'" get ProcessId,CommandLine /format:list`;
        }
    }

    private isAntigravityProcess(commandLine: string): boolean {
        const lowerCmd = commandLine.toLowerCase();

        if (/--app_data_dir\s+antigravity\b/i.test(commandLine)) {
            return true;
        }

        if (lowerCmd.includes('\\antigravity\\') || lowerCmd.includes('/antigravity/')) {
            return true;
        }
        return false;
    }

    /**
     * Parse process output to extract process information.
     * Hỗ trợ hai định dạng đầu ra: WMIC và PowerShell
     *
     * Định dạng WMIC:
     *   CommandLine=...--extension_server_port=1234 --csrf_token=abc123...
     *   ProcessId=5678
     *
     * Định dạng JSON PowerShell:
     *   {"ProcessId":5678,"CommandLine":"...--extension_server_port=1234 --csrf_token=abc123..."}
     *   hoặc mảng: [{"ProcessId":5678,"CommandLine":"..."}]
     */
    parseProcessInfo(stdout: string): {
        pid: number;
        extensionPort: number;
        csrfToken: string;
    } | null {
        // Thử phân tích đầu ra JSON PowerShell
        if (this.usePowerShell || stdout.trim().startsWith('{') || stdout.trim().startsWith('[')) {
            try {
                let data = JSON.parse(stdout.trim());
                // Nếu là mảng, lọc ra các tiến trình Antigravity
                if (Array.isArray(data)) {
                    if (data.length === 0) {
                        return null;
                    }
                    const totalCount = data.length;
                    // Lọc ra các tiến trình Antigravity
                    const antigravityProcesses = data.filter((item: any) =>
                        item.CommandLine && this.isAntigravityProcess(item.CommandLine)
                    );
                    logger.info(`[WindowsProcessDetector] Found ${totalCount} language_server process(es), ${antigravityProcesses.length} belong to Antigravity`);
                    if (antigravityProcesses.length === 0) {
                        logger.info('[WindowsProcessDetector] No Antigravity process found, skipping non-Antigravity processes');
                        return null;
                    }
                    if (totalCount > 1) {
                        logger.info(`[WindowsProcessDetector] Selected Antigravity process PID: ${antigravityProcesses[0].ProcessId}`);
                    }
                    data = antigravityProcesses[0];
                } else {
                    // Khi là đối tượng đơn lẻ cũng cần kiểm tra xem có phải tiến trình Antigravity không
                    if (!data.CommandLine || !this.isAntigravityProcess(data.CommandLine)) {
                        logger.info('[WindowsProcessDetector] Single process found but not Antigravity, skipping');
                        return null;
                    }
                    logger.info(`[WindowsProcessDetector] Found 1 Antigravity process, PID: ${data.ProcessId}`);
                }

                const commandLine = data.CommandLine || '';
                const pid = data.ProcessId;

                if (!pid) {
                    return null;
                }

                const portMatch = commandLine.match(/--extension_server_port[=\s]+(\d+)/);
                const tokenMatch = commandLine.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);

                if (!tokenMatch || !tokenMatch[1]) {
                    return null;
                }

                const extensionPort = portMatch && portMatch[1] ? parseInt(portMatch[1], 10) : 0;
                const csrfToken = tokenMatch[1];

                return { pid, extensionPort, csrfToken };
            } catch (e) {
                // Phân tích JSON thất bại, tiếp tục thử định dạng WMIC
            }
        }

        // Phân tích định dạng đầu ra WMIC
        // Định dạng đầu ra WMIC là nhiều khối tiến trình, mỗi khối chứa các dòng CommandLine= và ProcessId=
        // Cần xử lý theo nhóm tiến trình, tránh nhầm lẫn tham số của các tiến trình khác nhau
        const blocks = stdout.split(/\n\s*\n/).filter(block => block.trim().length > 0);

        const candidates: Array<{ pid: number; extensionPort: number; csrfToken: string }> = [];

        for (const block of blocks) {
            const pidMatch = block.match(/ProcessId=(\d+)/);
            const commandLineMatch = block.match(/CommandLine=(.+)/);

            if (!pidMatch || !commandLineMatch) {
                continue;
            }

            const commandLine = commandLineMatch[1].trim();

            // Kiểm tra xem có phải tiến trình Antigravity không
            if (!this.isAntigravityProcess(commandLine)) {
                continue;
            }

            const portMatch = commandLine.match(/--extension_server_port[=\s]+(\d+)/);
            const tokenMatch = commandLine.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);

            if (!tokenMatch || !tokenMatch[1]) {
                continue;
            }

            const pid = parseInt(pidMatch[1], 10);
            const extensionPort = portMatch && portMatch[1] ? parseInt(portMatch[1], 10) : 0;
            const csrfToken = tokenMatch[1];

            candidates.push({ pid, extensionPort, csrfToken });
        }

        if (candidates.length === 0) {
            logger.info('[WindowsProcessDetector] WMIC: No Antigravity process found');
            return null;
        }

        logger.info(`[WindowsProcessDetector] WMIC: Found ${candidates.length} Antigravity process(es), using PID: ${candidates[0].pid}`);
        return candidates[0];
    }

    /**
     * Ensure port detection commands are available.
     * On Windows, netstat is always available as a system command.
     */
    async ensurePortCommandAvailable(): Promise<void> {
        // netstat is a built-in Windows command, always available
        return;
    }

    /**
     * Get command to list ports for a specific process using netstat.
     */
    getPortListCommand(pid: number): string {
        const netstat = WindowsProcessDetector.NETSTAT_PATH;
        const findstr = WindowsProcessDetector.FINDSTR_PATH;
        return `${netstat} -ano | ${findstr} "${pid}" | ${findstr} "LISTENING"`;
    }

    /**
     * Parse netstat output to extract listening ports.
     * Expected formats:
     *   TCP    127.0.0.1:2873         0.0.0.0:0              LISTENING       4412
     *   TCP    0.0.0.0:2873           0.0.0.0:0              LISTENING       4412
     *   TCP    [::1]:2873             [::]:0                 LISTENING       4412
     *   TCP    [::]:2873              [::]:0                 LISTENING       4412
     *   TCP    127.0.0.1:2873         *:*                    LISTENING       4412
     */
    parseListeningPorts(stdout: string): number[] {
        // Match IPv4: 127.0.0.1:port, 0.0.0.0:port
        // Match IPv6: [::1]:port, [::]:port
        // Foreign address can be: 0.0.0.0:0, *:*, [::]:0, etc.
        const portRegex = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?]):(\d+)\s+\S+\s+LISTENING/gi;
        const ports: number[] = [];
        let match;

        while ((match = portRegex.exec(stdout)) !== null) {
            const port = parseInt(match[1], 10);
            if (!ports.includes(port)) {
                ports.push(port);
            }
        }

        return ports.sort((a, b) => a - b);
    }

    /**
     * Get Windows-specific error messages.
     */
    getErrorMessages(): {
        processNotFound: string;
        commandNotAvailable: string;
        requirements: string[];
    } {
        return {
            processNotFound: 'language_server process not found',
            commandNotAvailable: this.usePowerShell
                ? 'PowerShell command failed; please check system permissions'
                : 'wmic/PowerShell command unavailable; please check the system environment',
            requirements: [
                'Antigravity is running',
                'language_server_windows_x64.exe process is running',
                this.usePowerShell
                    ? 'The system has permission to run PowerShell and netstat commands'
                    : 'The system has permission to run wmic/PowerShell and netstat commands (auto-fallback supported)'
            ]
        };
    }
}
