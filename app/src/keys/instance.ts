import { createKeyRegistry } from "./registry";
/** The app's one registry instance; screens register their shortcuts on it. */
export const keys = createKeyRegistry({ controlActive: () => false });
