# Gravity Orchestrator

[![Version](https://img.shields.io/badge/version-0.9.6-blue.svg)](https://github.com/anhnv02/gravity-orchestrator)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](https://opensource.org/licenses/MIT)

**Gravity Orchestrator** is a specialized extension for the **Antigravity IDE**, designed to provide real-time monitoring and intelligent management of your AI model quotas. It helps you stay focused on coding by ensuring your AI tools are always powered by an account with sufficient quota.

## 🚀 Key Features

### 📊 Real-time Quota Monitoring
- **Status Bar Integration**: Monitor your AI model quota status directly in the Antigravity status bar.
- **Visual Intelligence**: Color-coded indicators (🟢 Normal, 🟡 Warning, 🟠 Critical, 🔴 Depleted) provide instant feedback on your usage levels.
- **Interactive Tooltip**: Hover over the status bar icon for a detailed breakdown of model-specific quotas, remaining percentages, and reset times.

### 🔄 Intelligent Account Management
- **Multi-Account Support**: Login and manage multiple Google accounts simultaneously within Antigravity.
- **Visual Usage Tracking**: View exact usage percentages for every logged-in account through a sleek, progress-bar-driven interface.
- **Smart Switch Blocking**: Prevents manual switching to an account that is already below your defined quota threshold.
- **Cache-Optimized Performance**: Integrated background caching ensures updates are reflected instantly without slowing down your IDE.

### 🤖 Automatic Quota Protection (Auto-Switch)
- **Proactive Account Switching**: When your active account hits a low quota threshold (e.g., 10%), the extension can automatically rotate to the next available account with sufficient quota.
- **Exhaustion Guard**: If all available accounts are below your threshold, the extension stops switching and notifies you, preventing interrupted AI assisted coding.
- **Circular Search Logic**: Intelligently finds the best "next" account, skipping expired or low-quota ones.

### 🎛️ Elegant Control Panel
- **Dual-Tab Dashboard**: Access advanced features through an integrated webview interface.
- **Quota Tab**: A deep dive into your currently active account's models and credits.
- **Account Management Tab**: Your command center for adding, switching, and monitoring all authenticated accounts.

## ⚙️ Configuration

Tailor the extension to your workflow via the Antigravity settings:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `gravityOrchestrator.enabled` | `boolean` | `true` | Enable or disable the extension globally. |
| `gravityOrchestrator.pollingInterval` | `number` | `60` | Background refresh frequency in seconds. |
| `gravityOrchestrator.autoSwitchAccount` | `boolean` | `false` | Enable automatic switching when quota is low. |
| `gravityOrchestrator.switchThreshold` | `number` | `10` | The percentage (0-100) below which a quota is considered "low". |
| `gravityOrchestrator.apiMethod` | `enum` | `GOOGLE_API` | `GOOGLE_API` (Recommended) or `GET_USER_STATUS` (Local). |

## 🛠️ Commands

| Command | Action |
|---------|--------|
| `Gravity Orchestrator: Show Control Panel` | Opens the main dashboard. |
| `Gravity Orchestrator: Manage Accounts` | Jumps directly to account management. |
| `Gravity Orchestrator: Refresh Quota` | Triggers an immediate manual update. |
| `Gravity Orchestrator: Login with Google` | Securely add a new account via OAuth. |
| `Gravity Orchestrator: Logout from Google` | Remove the currently active account. |

## � Requirements

- **IDE**: Antigravity IDE (compatible with extension engine version 1.85.0+).
- **Account**: A Google account with access to Antigravity AI models.
- **Models Supported**: Gemini (3.0+), Claude, and GPT series.

## 🤝 Contributing

Contributions are welcome! If you find a bug or have a feature request, please open an issue or submit a pull request on our [GitHub repository](https://github.com/anhnv02/gravity-orchestrator).

## 📄 License

This project is licensed under the **MIT License**.
