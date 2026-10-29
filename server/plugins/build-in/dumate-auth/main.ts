import { defineProviderPlugin } from "cursor-byok:plugin";
import { dumateProvider } from "./provider.ts";
import { credentialImport, presentAccount, refreshAccount, RESOURCE_TYPE } from "./resources.ts";

export default defineProviderPlugin({
  providers: [dumateProvider],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: { "zh-CN": "DuMate 账号", "en-US": "DuMate accounts" },
    import: credentialImport,
    present: presentAccount,
    refresh: refreshAccount,
  }],
});
