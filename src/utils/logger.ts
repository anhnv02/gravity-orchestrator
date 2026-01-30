import * as vscode from 'vscode';

export enum LogLevel {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3
}

class Logger {
    private static instance: Logger;
    private outputChannel: vscode.LogOutputChannel | undefined;
    private name: string = 'Gravity Orchestrator';

    private constructor() {}

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    /**
     * Initialize the logger with a VS Code output channel
     */
    public initialize(context: vscode.ExtensionContext): void {
        this.outputChannel = vscode.window.createOutputChannel(this.name, { log: true });
        context.subscriptions.push(this.outputChannel);
    }

    public debug(message: string, ...args: any[]): void {
        this.log(LogLevel.Debug, message, ...args);
    }

    public info(message: string, ...args: any[]): void {
        this.log(LogLevel.Info, message, ...args);
    }

    public warn(message: string, ...args: any[]): void {
        this.log(LogLevel.Warn, message, ...args);
    }

    public error(message: string | Error, ...args: any[]): void {
        if (message instanceof Error) {
            this.log(LogLevel.Error, message.message, ...args);
            if (message.stack) {
                this.log(LogLevel.Debug, `Stack trace: ${message.stack}`);
            }
        } else {
            this.log(LogLevel.Error, message, ...args);
        }
    }

    private log(level: LogLevel, message: string, ...args: any[]): void {
        if (!this.outputChannel) {
            // Fallback to console if channel not yet initialized
            const timestamp = new Date().toISOString();
            const levelName = LogLevel[level].toUpperCase();
            console.log(`[${timestamp}] [${levelName}] ${message}`, ...args);
            return;
        }

        const formattedArgs = args.map(arg => 
            typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg
        ).join(' ');

        const fullMessage = formattedArgs ? `${message} ${formattedArgs}` : message;

        switch (level) {
            case LogLevel.Debug:
                this.outputChannel.debug(fullMessage);
                break;
            case LogLevel.Info:
                this.outputChannel.info(fullMessage);
                break;
            case LogLevel.Warn:
                this.outputChannel.warn(fullMessage);
                break;
            case LogLevel.Error:
                this.outputChannel.error(fullMessage);
                break;
        }
    }

    public show(): void {
        this.outputChannel?.show();
    }
}

export const logger = Logger.getInstance();
