import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createPinHandlers, forgetAgentPins } from "./server/account-pins";
import { listAccounts } from "./server/accounts";
import { cancelLogin, loginInput, loginStatus, startLogin, stopCurrentLogin } from "./server/login";
import { removeAccount } from "./server/remove";
import {
  cancelLoginRpc,
  listAccountPinsRpc,
  listAccountsRpc,
  loginInputRpc,
  loginStatusRpc,
  pinAccountRpc,
  preferences,
  removeAccountRpc,
  startLoginRpc,
} from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const { listAccountPins, pinAccount } = createPinHandlers(settings);
  server.handle(listAccountsRpc, listAccounts);
  server.handle(removeAccountRpc, removeAccount);
  server.handle(startLoginRpc, startLogin);
  server.handle(loginStatusRpc, loginStatus);
  server.handle(loginInputRpc, loginInput);
  server.handle(cancelLoginRpc, cancelLogin);
  server.handle(listAccountPinsRpc, listAccountPins);
  server.handle(pinAccountRpc, pinAccount);
  const stopForgettingPins = server.on("agent.archived", ({ agent }) => forgetAgentPins(agent.id));
  return () => {
    stopForgettingPins();
    void stopCurrentLogin();
  };
}
