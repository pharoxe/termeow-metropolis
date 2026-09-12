import path from "node:path";
import { fomoscanDirectory } from "./fomoscanAccount.js";
import { IdentityRegistry } from "./identityRegistry.js";

/** Process-local gateway cache. Put `fomoscanDirectory` on a Railway volume to make it durable across deploys. */
export const identityRegistry = new IdentityRegistry(path.join(fomoscanDirectory, "identity.db"));
