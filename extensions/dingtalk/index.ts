import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { dingtalkPlugin } from "./src/channel.js";
import { setDingTalkRuntime } from "./src/runtime.js";

export { monitorDingTalkProvider } from "./src/monitor.js";
export { replyText, replyCard, updateCard, finishCard, prepareCard } from "./src/send.js";
export { probeDingTalk } from "./src/probe.js";
export { dingtalkPlugin } from "./src/channel.js";

const plugin = {
  id: "dingtalk",
  name: "DingTalk",
  description: "DingTalk channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setDingTalkRuntime(api.runtime);
    api.registerChannel({ plugin: dingtalkPlugin });
  },
};

export default plugin;
