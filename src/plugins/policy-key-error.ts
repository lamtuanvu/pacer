import {CoreError} from "../core/errors";

/** Host-only fault while loading the private key used for policy metadata. */
export class PolicyHashKeyError extends CoreError {
  constructor(message:string) {super("invalid_input",message);this.name="PolicyHashKeyError";}
}
