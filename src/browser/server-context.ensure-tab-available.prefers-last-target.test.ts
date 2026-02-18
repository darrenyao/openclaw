import { describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import type { BrowserServerState } from "./server-context.js";
import "./server-context.chrome-test-harness.js";
import { createBrowserRouteContext } from "./server-context.js";

function makeBrowserState(): BrowserServerState {
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    server: null as any,
    port: 0,
    resolved: {
      enabled: true,
      controlPort: 18791,
      cdpProtocol: "http",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      evaluateEnabled: false,
      remoteCdpTimeoutMs: 1500,
      remoteCdpHandshakeTimeoutMs: 3000,
      extraArgs: [],
      color: "#FF4500",
      headless: true,
      noSandbox: false,
      attachOnly: false,
      defaultProfile: "chrome",
      profiles: {
        chrome: {
          driver: "extension",
          cdpUrl: "http://127.0.0.1:18792",
          cdpPort: 18792,
          color: "#00AA00",
        },
        openclaw: { cdpPort: 18800, color: "#FF4500" },
      },
    },
    profiles: new Map(),
  };
}

function stubChromeJsonList(responses: unknown[]) {
  const fetchMock = vi.fn();
  const queue = [...responses];

  fetchMock.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (!u.includes("/json/list")) {
      throw new Error(`unexpected fetch: ${u}`);
    }
    const next = queue.shift();
    if (!next) {
      throw new Error("no more responses");
    }
    return {
      ok: true,
      json: async () => next,
    } as unknown as Response;
  });

  global.fetch = withFetchPreconnect(fetchMock);
  return fetchMock;
}

describe("browser server-context ensureTabAvailable", () => {
  it("sticks to the last selected target when targetId is omitted", async () => {
    // 1st call (snapshot): stable ordering A then B (twice)
    // 2nd call (act): reversed ordering B then A (twice)
    const responses = [
      [
        { id: "A", type: "page", url: "https://a.example", webSocketDebuggerUrl: "ws://x/a" },
        { id: "B", type: "page", url: "https://b.example", webSocketDebuggerUrl: "ws://x/b" },
      ],
      [
        { id: "A", type: "page", url: "https://a.example", webSocketDebuggerUrl: "ws://x/a" },
        { id: "B", type: "page", url: "https://b.example", webSocketDebuggerUrl: "ws://x/b" },
      ],
      [
        { id: "B", type: "page", url: "https://b.example", webSocketDebuggerUrl: "ws://x/b" },
        { id: "A", type: "page", url: "https://a.example", webSocketDebuggerUrl: "ws://x/a" },
      ],
      [
        { id: "B", type: "page", url: "https://b.example", webSocketDebuggerUrl: "ws://x/b" },
        { id: "A", type: "page", url: "https://a.example", webSocketDebuggerUrl: "ws://x/a" },
      ],
    ];
    stubChromeJsonList(responses);
    const state = makeBrowserState();

    const ctx = createBrowserRouteContext({
      getState: () => state,
    });

    const chrome = ctx.forProfile("chrome");
    const first = await chrome.ensureTabAvailable();
    expect(first.targetId).toBe("A");
    const second = await chrome.ensureTabAvailable();
    expect(second.targetId).toBe("A");
  });

  it("falls back to the only attached tab when an invalid targetId is provided (extension)", async () => {
    const responses = [
      [{ id: "A", type: "page", url: "https://a.example", webSocketDebuggerUrl: "ws://x/a" }],
      [{ id: "A", type: "page", url: "https://a.example", webSocketDebuggerUrl: "ws://x/a" }],
    ];
    stubChromeJsonList(responses);
    const state = makeBrowserState();

    const ctx = createBrowserRouteContext({ getState: () => state });
    const chrome = ctx.forProfile("chrome");
    const chosen = await chrome.ensureTabAvailable("NOT_A_TAB");
    expect(chosen.targetId).toBe("A");
  });

  it("auto-creates a tab via openTab when no extension tabs are attached", async () => {
    const fetchMock = vi.fn();
    // 1st listTabs(): empty (triggers openTab)
    // openTab issues Target.createTarget via CDP then polls listTabs, so we need:
    //   - a PUT /json/new response for the fallback path
    //   - 2nd listTabs(): now has the created tab
    //   - 3rd listTabs(): used by ensureTabAvailable's second call
    const responses: Array<unknown[]> = [
      [], // 1st listTabs: empty
      [
        {
          id: "NEW1",
          type: "page",
          url: "about:blank",
          title: "",
          webSocketDebuggerUrl: "ws://x/new1",
        },
      ], // 2nd listTabs (after openTab)
      [
        {
          id: "NEW1",
          type: "page",
          url: "about:blank",
          title: "",
          webSocketDebuggerUrl: "ws://x/new1",
        },
      ], // 3rd listTabs
    ];

    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/json/list")) {
        const next = responses.shift();
        if (!next) {
          throw new Error("no more responses");
        }
        return { ok: true, json: async () => next } as unknown as Response;
      }
      // createTargetViaCdp path — simulate success
      if (u.includes("/json/new")) {
        return {
          ok: true,
          json: async () => ({ id: "NEW1", type: "page", url: "about:blank", title: "" }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    global.fetch = fetchMock;

    const state: BrowserServerState = {
      // oxlint-disable-next-line typescript/no-explicit-any
      server: null as any,
      port: 0,
      resolved: {
        enabled: true,
        controlPort: 18791,
        cdpProtocol: "http",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        color: "#FF4500",
        headless: true,
        noSandbox: false,
        attachOnly: false,
        defaultProfile: "chrome",
        profiles: {
          chrome: {
            driver: "extension",
            cdpUrl: "http://127.0.0.1:18792",
            cdpPort: 18792,
            color: "#00AA00",
          },
          openclaw: { cdpPort: 18800, color: "#FF4500" },
        },
      },
      profiles: new Map(),
    };

    const ctx = createBrowserRouteContext({ getState: () => state });
    const chrome = ctx.forProfile("chrome");
    const tab = await chrome.ensureTabAvailable();
    expect(tab.targetId).toBe("NEW1");
  });
});
