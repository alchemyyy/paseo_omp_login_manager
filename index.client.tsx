import type { PluginClientContext } from "@getpaseo/plugin/client";
import { startAccountPills } from "./client/account-pills";
import { AccountsItem } from "./client/accounts-item";

export default function contribute(client: PluginClientContext) {
  // NOTE: the id predates Claude Code support; keep it so users' sidebar order and visibility survive
  const removeSidebarItem = client.addSidebarHeaderItem({ id: "omp-accounts", title: "Accounts", Component: AccountsItem });
  const stopAccountPills = startAccountPills(client);
  return () => {
    stopAccountPills();
    void removeSidebarItem();
  };
}
