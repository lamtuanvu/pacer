import Foundation
@main struct LayoutTests {
    static func main() throws {
        let size = CGSize(width: 288, height: 140)
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
        let json = try JSONSerialization.data(withJSONObject:["positions":positions,"bundles":bundles,"exclusive":firstAcquired && secondDenied && thirdAcquired])
        FileHandle.standardOutput.write(json)
    }
}
