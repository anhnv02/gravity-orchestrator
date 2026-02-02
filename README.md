# Gravity Orchestrator

![Version](https://img.shields.io/badge/version-1.0.3-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

**Gravity Orchestrator** is the ultimate companion for the Antigravity IDE ecosystem, designed to give you complete control over your AI model quotas. It features real-time monitoring, seamless multi-account management, and a dedicated sidebar interface for deep insights.

## Features

- **📊 Real-Time Quota Monitoring**: Instantly view remaining quota percentages for top-tier models like Gemini 3 Flash, Claude 4.5 Sonnet, and more.
- **👥 Multi-Account Management**: 
  - **Add multiple Google accounts** and switch between them instantly.
  - **Auto-Sync** with Gravity Orchestrator app for a unified experience.
  - **Session management** to handle logins, logouts, and token refreshes.
- **🖥️ Dedicated Control Panel**: A rich Sidebar View (`Gravity Agent`) that provides:
  - Detailed model usage breakdown.
  - Account switching interface.

- **⚡ Status Bar Integration**: Unobtrusive status indicator that changes color based on your remaining quota.
- **🔄 Auto-Discovery**: Automatically detects and imports login tokens from your local Antigravity IDE installation.

## Usage

### Sidebar Control Panel
Click the **"G"** icon in the Activity Bar to open the **Gravity Agent** sidebar.
- **Top Section**: Shows your active account.
- **Account List**: Dropdown to switch between added accounts.
- **Quota List**: Progress bars for each available model.
- **Actions**: Buttons to add accounts or logout.

### Status Bar
The status bar item (bottom right) is your quick-glance monitor:
- 🟢 **Green**: Healthy quota (>50%)
- 🟡 **Yellow**: Warning level (30-50%)
- 🟠 **Orange**: Critical level (<30%)
- 🔴 **Red**: Quota exhausted

**Interactions:**
- **Click**: Opens the Gravity Agent sidebar.
- **Hover**: Shows a rapid summary of all models.

### Commands
Access these via the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

| Command | Description |
|---------|-------------|
| `Gravity Orchestrator: Show Control Panel` | Opens the main sidebar interface. |
| `Gravity Orchestrator: Quick Refresh Quota` | Forces an immediate update of quota data. |
| `Gravity Orchestrator: Login with Google` | Starts the OAuth flow to add a new account. |
| `Gravity Orchestrator: Add Account` | Add an additional Google account to your session. |
| `Gravity Orchestrator: Logout` | Sign out of the current active account. |
| `Gravity Orchestrator: Refresh Quota` | Triggers a full retry/fetch cycle (useful if stuck). |

## Configuration

Customize the experience in VS Code Settings:

- **`gravityOrchestrator.enabled`**: 
  - `true` (default): Extension is active.
  - `false`: Disables all background polling.
- **`gravityOrchestrator.pollingInterval`**: 
  - Default: `30` (seconds).
  - Determines how frequently the extension checks for quota updates. Minimum is 10s.

## Requirements

1. **Antigravity IDE** (Highly Recommended): The extension works best when it can auto-sync with your main IDE installation.
2. **Google Account**: Necessary for accessing the AI models.

## License

MIT
