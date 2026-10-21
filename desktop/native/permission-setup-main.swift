import Foundation
import Darwin

@main struct PermissionSetupMain {
    @MainActor static func main() {
        var result:[String:Any]=["status":"target_unavailable","accessibility":false]
        // The bundled entry is callable only for its launching desktop process.
        // It accepts no application path, script, URL or arbitrary target.
        if CommandLine.arguments.count == 2,let pid=Int32(CommandLine.arguments[1]),pid==getppid(),let identity=permissionProcessIdentity(pid) {
            result=runPermissionChip(["pid":Int(pid),"start_identity":identity,"timeout_ms":180000])
        }
        if let data=try? JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]) { FileHandle.standardOutput.write(data) }
    }
}
