import Foundation
import CoreFoundation
import CoreGraphics
import ApplicationServices


// AX provider reads are substituted so real selection/traversal code runs without
// observing applications, requesting permission, or delivering native input.
final class FakeNode: NSObject {
    let name: String
    var fields: [String: Any] = [:]
    var children: [FakeNode] = []
    var pid: Int32? = 41
    var rect: CGRect? = CGRect(x: 10, y: 20, width: 100, height: 200)
    init(_ name: String, role: String = "AXWindow") {
        self.name = name
        super.init()
        fields["AXRole"] = role; fields["AXTitle"] = "owned"
    }
    // Hash collision is intentional: equality must never be inferred from hash.
    override var hash: Int { 7 }
    override func isEqual(_ object: Any?) -> Bool { (object as? FakeNode)?.name == name }
}
typealias AXUIElement = FakeNode
let kAXWindowsAttribute = "AXWindows", kAXTitleAttribute = "AXTitle", kAXRoleAttribute = "AXRole"
let kAXSubroleAttribute = "AXSubrole", kAXDescriptionAttribute = "AXDescription", kAXHelpAttribute = "AXHelp"
let kAXValueAttribute = "AXValue", kAXFocusedAttribute = "AXFocused", kAXEnabledAttribute = "AXEnabled"
let kCGWindowName = "CGWindowName", kCGWindowBounds = "CGWindowBounds"
let app = FakeNode("app", role: "AXApplication")
func AXIsProcessTrusted() -> Bool { true }
func AXUIElementCreateApplication(_ pid: Int32) -> FakeNode { app }
func AXUIElementGetTypeID() -> CFTypeID { CFGetTypeID(app) }
func attribute(_ node: FakeNode, _ key: String) -> CFTypeRef? {
    if let value = node.fields[key] { return value as AnyObject }
    if key == kAXPositionAttribute, var point = node.rect?.origin { return AXValueCreate(.cgPoint, &point) }
    if key == kAXSizeAttribute, var size = node.rect?.size { return AXValueCreate(.cgSize, &size) }
    return nil
}
func text(_ node: FakeNode, _ key: String) -> String { node.fields[key] as? String ?? "" }
func role(_ node: FakeNode) -> String { text(node, "AXRole") }
func axChildren(_ node: FakeNode) -> [FakeNode] { node.children }
func AXUIElementGetPid(_ node: FakeNode, _ pid: inout Int32) -> AXError {
    guard let owner = node.pid else { return .failure }
    pid = owner
    return .success
}

// PRODUCTION_FUNCTIONS

let info: [String: Any] = ["CGWindowName": "owned", "CGWindowBounds": ["X":10.0,"Y":20.0,"Width":100.0,"Height":200.0]]
func resolves(_ nodes: [AnyObject]) -> Bool {
    app.fields["AXWindows"] = nodes
    return (try? axRoot(41, info)) != nil
}
var checks: [String: Bool] = [:]
let valid = FakeNode("valid")
checks["ownedUnique"] = resolves([valid])
checks["applicationRejected"] = !resolves([app])
let wrongPID = FakeNode("wrong-pid"); wrongPID.pid = 42
checks["wrongPIDRejected"] = !resolves([wrongPID])
let unreadablePID = FakeNode("unreadable-pid"); unreadablePID.pid = nil
checks["unreadablePIDRejected"] = !resolves([unreadablePID])
checks["invalidMemberRejected"] = !resolves(["not an AX element" as NSString])
let wrongTitle = FakeNode("wrong-title"); wrongTitle.fields["AXTitle"] = "different"
checks["wrongTitleRejected"] = !resolves([wrongTitle])
let moved = FakeNode("moved"); moved.rect = CGRect(x: 50, y: 20, width: 100, height: 200)
checks["wrongGeometryRejected"] = !resolves([moved])
let missing = FakeNode("missing"); missing.rect = nil
checks["missingGeometryRejected"] = !resolves([missing])
let badPosition = FakeNode("bad-position"); badPosition.fields[kAXPositionAttribute] = "invalid"
checks["wrongPositionTypeRejected"] = !resolves([badPosition])
let badSize = FakeNode("bad-size"); badSize.fields[kAXSizeAttribute] = "invalid"
checks["wrongSizeTypeRejected"] = !resolves([badSize])
var wrongKind = CGSize(width: 10, height: 20)
let badKind = FakeNode("bad-kind"); badKind.fields[kAXPositionAttribute] = AXValueCreate(.cgSize, &wrongKind)
checks["wrongAXValueKindRejected"] = !resolves([badKind])
let rounded = FakeNode("rounded"); rounded.rect = CGRect(x: 10.5, y: 20, width: 100, height: 200)
checks["roundedGeometryAccepted"] = resolves([rounded])
let outsideTolerance = FakeNode("outside"); outsideTolerance.rect = CGRect(x: 11.1, y: 20, width: 100, height: 200)
checks["outsideToleranceRejected"] = !resolves([outsideTolerance])
let nonfinite = FakeNode("nonfinite"); nonfinite.rect = CGRect(x: Double.infinity, y: 20, width: 100, height: 200)
checks["nonfiniteGeometryRejected"] = !resolves([nonfinite])
checks["ambiguousRejected"] = !resolves([valid, FakeNode("other")])
checks["sameTitleOtherGeometryIgnored"] = resolves([valid, moved])
let selfCycle = FakeNode("self"); selfCycle.children = [selfCycle]
let (selfElements, _, selfTruncated) = inspectTree(selfCycle)
checks["selfCycleBounded"] = selfElements.count == 1 && selfTruncated
let a = FakeNode("a"), b = FakeNode("b"); a.children = [b]; b.children = [a]
let (mutual, _, mutualTruncated) = inspectTree(a)
checks["mutualCycleBounded"] = mutual.count == 2 && mutualTruncated
let root = FakeNode("root"), first = FakeNode("first"), second = FakeNode("second")
root.children = [first, second]
let (collision, _, collisionTruncated) = inspectTree(root)
checks["hashCollisionRetained"] = collision.count == 3 && !collisionTruncated
let aliasRoot = FakeNode("alias-root"), shared = FakeNode("shared")
aliasRoot.children = [shared, FakeNode("shared")]
let (aliases, _, aliasesTruncated) = inspectTree(aliasRoot)
checks["aliasesDeduplicated"] = aliases.count == 2 && aliasesTruncated
let deliveryCases = [(false, "not_delivered"), (true, "unknown")]
for (attempted, expected) in deliveryCases {
    let delivery = NativeDelivery()
    do {
        try delivery.run {
            if attempted { _ = delivery.attempt { false } }
            try fail("target_unavailable", "raise failed")
        }
        checks["delivery-\(expected)"] = false
    } catch let error as NativeFailure {
        checks["delivery-\(expected)"] = error.delivery == expected
    }
}
let partial = NativeDelivery()
var effects = 0
var effectDelivery = ""
do {
    try partial.run {
        _ = partial.attempt { effects += 1; return true }
        _ = partial.attempt { false }
        try fail("target_unavailable", "raise failed")
    }
} catch let error as NativeFailure { effectDelivery = error.delivery }
checks["partialActivationUnknown"] = effects == 1 && effectDelivery == "unknown"
print(String(data: try JSONSerialization.data(withJSONObject: checks, options: .sortedKeys), encoding: .utf8)!)
