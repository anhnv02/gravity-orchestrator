import * as vscode from 'vscode';
import { Config } from './types';

export class ConfigService {
  private readonly configKey = 'gravityOrchestrator';

  getConfig(): Config {
    const config = vscode.workspace.getConfiguration(this.configKey);
    return {
      enabled: config.get<boolean>('enabled', true),
      pollingInterval: Math.max(10, config.get<number>('pollingInterval', 60)) * 1000,
      apiMethod: (config.get<string>('apiMethod', 'GET_USER_STATUS') as Config['apiMethod']),
      autoSwitchAccount: config.get<boolean>('autoSwitchAccount', false),
      switchThreshold: config.get<number>('switchThreshold', 10)
    };
  }

  onConfigChange(callback: (config: Config) => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(this.configKey)) {
        callback(this.getConfig());
      }
    });
  }
}
