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
     * Supports two output formats: WMIC and PowerShell
     *
     * WMIC format:
     *   CommandLine=...--extension_server_port=1234 --csrf_token=abc123...
     *   ProcessId=5678
     *
     * PowerShell JSON format:
     *   {"ProcessId":5678,"CommandLine":"...--extension_server_port=1234 --csrf_token=abc123..."}
     *   or array: [{"ProcessId":5678,"CommandLine":"..."}]
     */
    parseProcessInfo(stdout: string): {
        pid: number;
        extensionPort: number;
        csrfToken: string;
    } | null {
        // Try parsing PowerShell JSON output
        if (this.usePowerShell || stdout.trim().startsWith('{') || stdout.trim().startsWith('[')) {
            try {
                let data = JSON.parse(stdout.trim());
                // If it's an array, filter for Antigravity processes
                if (Array.isArray(data)) {
                    if (data.length === 0) {
                        return null;
                    }
                    const totalCount = data.length;
                    // Filter for Antigravity processes
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
                    // For single objects, also verify if it's an Antigravity process
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
                // JSON parsing failed, continuing with WMIC format attempt
            }
        }

        // Parse WMIC output format
        // WMIC output consists of multiple process blocks, each containing CommandLine= and ProcessId= lines
        // Must process by groups to avoid parameter confusion between different processes
        const blocks = stdout.split(/\n\s*\n/).filter(block => block.trim().length > 0);

        const candidates: Array<{ pid: number; extensionPort: number; csrfToken: string }> = [];

        for (const block of blocks) {
            const pidMatch = block.match(/ProcessId=(\d+)/);
            const commandLineMatch = block.match(/CommandLine=(.+)/);

            if (!pidMatch || !commandLineMatch) {
                continue;
            }

            const commandLine = commandLineMatch[1].trim();

            // Check if it's an Antigravity process
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
