import { getAccessToken, useSigners } from "@privy-io/react-auth";
import { api } from "../api/client";

type LinkedWallet = { type: string; address?: string; id?: string | null; chainType?: string; chain_type?: string };

export function useAutomationDelegation(walletAddress?: string) {
  const { addSigners } = useSigners();

  const ensureDelegated = async () => {
    if (!walletAddress) throw new Error("Your embedded Monad wallet is still being created.");
    const token = await getAccessToken();
    if (!token) throw new Error("Privy session expired. Log in again.");
    const setup = await api.automationDelegation(token);
    if (setup.active && setup.walletAddress?.toLowerCase() === walletAddress.toLowerCase()) return setup;
    if (!setup.configured || !setup.signerId || !setup.policyIds.length) throw new Error("The server automation signer has not been configured yet.");
    const result = await addSigners({ address: walletAddress, signers: [{ signerId: setup.signerId, policyIds: setup.policyIds }] });
    const account = result.user.linkedAccounts.find((candidate) => {
      const wallet = candidate as LinkedWallet;
      return wallet.type === "wallet" && wallet.address?.toLowerCase() === walletAddress.toLowerCase() && (wallet.chainType === "ethereum" || wallet.chain_type === "ethereum");
    }) as LinkedWallet | undefined;
    if (!account?.id) throw new Error("Privy added the signer but did not return a server wallet ID. Refresh and try once more.");
    await api.confirmAutomationDelegation(token, { walletAddress, walletId: account.id });
    return api.automationDelegation(token);
  };

  return { ensureDelegated };
}
