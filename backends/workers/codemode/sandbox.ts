import { RemoteCodemodeSandbox, type CodemodeExecuteOptions, type CodemodeRunOptions } from "@earendil-works/pi-codemode/portable";
import { FS_SHIM } from "./fs-shim.ts";

/** The shared fs compatibility shim is the only code prepended to stock Pi. */
export class SessionCodemodeSandbox extends RemoteCodemodeSandbox {
  override execute(code: string, options?: CodemodeExecuteOptions) {
    return super.execute(FS_SHIM + code, options);
  }
  override start(code: string, options: CodemodeRunOptions) {
    return super.start(FS_SHIM + code, options);
  }
}
