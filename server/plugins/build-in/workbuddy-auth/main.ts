import { defineProviderPlugin } from "cursor-byok:plugin";
import { workbuddyProvider } from "./provider.ts";
import { presentAccount, refreshAccount, RESOURCE_TYPE } from "./resources.ts";
import { workbuddyOAuth } from "./oauth.ts";

export default defineProviderPlugin({
  providers: [workbuddyProvider],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: { "en-US": "WorkBuddy accounts", "zh-CN": "WorkBuddy 账号" },
    add: [workbuddyOAuth],
    present: presentAccount,
    refresh: refreshAccount,
  }],
});
