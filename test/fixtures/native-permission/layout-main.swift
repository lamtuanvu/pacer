import Foundation
import AppKit
@main struct LayoutTests {
    @MainActor static func main() throws {
        if CommandLine.arguments.count > 2 {
            let mode=CommandLine.arguments[1], path=CommandLine.arguments[2]
            if mode == "launcher" {
                let child=Process();child.executableURL=URL(fileURLWithPath:CommandLine.arguments[0]);child.arguments=["orphan",path]
                try child.run()
                for _ in 0..<100 { if FileManager.default.fileExists(atPath:path+".ready") { return };Thread.sleep(forTimeInterval:0.01) }
                throw NSError(domain:"launcher",code:1)
            }
            if mode == "orphan" {
                let controller=PermissionChipController(appURL:URL(fileURLWithPath:"/Applications/Finder.app"),targetPID:getpid(),identity:permissionProcessIdentity(getpid())!,timeout:5)
                try Data().write(to:URL(fileURLWithPath:path+".ready"))
                for _ in 0..<100 { if getppid() != controller.launcherPID { break };Thread.sleep(forTimeInterval:0.01) }
                controller.tick()
                try JSONSerialization.data(withJSONObject:controller.result).write(to:URL(fileURLWithPath:path))
                return
            }
        }
        let size = CGSize(width: 440, height: 70)
        let cases: [(CGRect, CGRect)] = [
            (CGRect(x:200,y:100,width:500,height:600), CGRect(x:0,y:0,width:1440,height:900)),
            (CGRect(x:900,y:100,width:500,height:600), CGRect(x:0,y:0,width:1440,height:900)),
            (CGRect(x:-1250,y:100,width:700,height:700), CGRect(x:-1440,y:0,width:1440,height:900)),
            (CGRect(x:250,y:100,width:500,height:600), CGRect(x:0,y:0,width:1440,height:900)),
            (CGRect(x:0,y:0,width:1440,height:900), CGRect(x:0,y:0,width:1440,height:900)),
            (CGRect(x:0,y:0,width:320,height:240), CGRect(x:0,y:0,width:320,height:240))
        ]
        let positions = cases.map { window, screen -> [String:Any] in
            let placement = permissionChipPlacement(settings: window, visible: screen, preferred: size)
            return ["x":placement.frame.minX,"y":placement.frame.minY,"width":placement.frame.width,"height":placement.frame.height,"compact":placement.compact,"contained":screen.contains(placement.frame),"overlap":window.intersects(placement.frame)]
        }
        let bundles: [Any] = [permissionHostingBundlePath("/Applications/Host.app/Contents/Frameworks/Host Helper.app/Contents/MacOS/helper") as Any? ?? NSNull(),permissionHostingBundlePath("/opt/bin/helper") as Any? ?? NSNull(),permissionHostingBundlePath("/Applications/Ứng dụng.app/Contents/MacOS/tool") as Any? ?? NSNull()]
        var firstLease: PermissionChipLease? = try? PermissionChipLease(targetPID:getpid())
        let firstAcquired = firstLease != nil
        let secondDenied = (try? PermissionChipLease(targetPID:getpid())) == nil
        firstLease = nil
        let thirdAcquired = (try? PermissionChipLease(targetPID:getpid())) != nil
        let json = try JSONSerialization.data(withJSONObject:["visibleWhileSettingsFrontmost":permissionChipShouldShow(settingsOnScreen:true),"visibleWhileAnotherAppFrontmost":permissionChipShouldShow(settingsOnScreen:true),"hiddenOffScreen":permissionChipShouldShow(settingsOnScreen:false),"launcherAlive":permissionLauncherIsAlive(getpid(),identity:permissionProcessIdentity(getpid())),"launcherReplaced":permissionLauncherIsAlive(getpid(),identity:"replaced"),"launcherMissing":permissionLauncherIsAlive(1,identity:nil),"positions":positions,"bundles":bundles,"exclusive":firstAcquired && secondDenied && thirdAcquired])
        FileHandle.standardOutput.write(json)
    }
}
