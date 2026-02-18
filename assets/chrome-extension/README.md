# OpenClaw Chrome Extension (Browser Relay)

Purpose: attach OpenClaw to an existing Chrome tab so the Gateway can automate it (via the local CDP relay server).

## Dev / load unpacked

1. Build/run OpenClaw Gateway with browser control enabled.
2. Ensure the relay server is reachable at `http://127.0.0.1:18792/` (default).
3. Install the extension to a stable path:

   ```bash
   openclaw browser extension install
   openclaw browser extension path
   ```

4. Chrome → `chrome://extensions` → enable "Developer mode".
5. "Load unpacked" → select the path printed above.
6. Pin the extension. Click the icon on a tab to attach/detach.

## Auto-attach (headless / unattended)

The extension automatically connects to the relay server on Chrome startup — no manual click required. This enables headless Mac Mini / kiosk setups where Chrome is a login item.

**Startup flow:**

1. Chrome launches → service worker starts → `onStartup` fires
2. After ~6 s alarm delay → `tryAutoConnect()` attempts WebSocket connection
3. If relay isn't ready → retries every 1 minute
4. If connection drops → retries every 30 seconds
5. Once connected → agent can create tabs via `Target.createTarget`

Agent-created tabs are grouped into an orange **"OpenClaw"** tab group to separate them from user tabs. Child tabs (e.g. link clicks) are auto-captured into the same group.

Manual click-to-toggle still works as before.

## Options

- `Relay port`: defaults to `18792`.
- `Gateway token`: required. Set this to `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`).
