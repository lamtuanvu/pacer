import Darwin
import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit

struct NativeFailure: Error { let code: String; let message: String; var delivery: String = "not_delivered" }
func fail(_ code: String, _ message: String) throws -> Never { throw NativeFailure(code: code, message: message) }
// Once a platform mutation is invoked, an error cannot prove zero effects.
final class NativeDelivery {
    private var attempted = false
    func attempt<T>(_ effect: () throws -> T) rethrows -> T {
        attempted = true
        return try effect()
    }
    func run<T>(_ action: () throws -> T) throws -> T {
        do { return try action() }
        catch var failure as NativeFailure {
            if attempted { failure.delivery = "unknown" }
            throw failure
        } catch {
            throw NativeFailure(code: "observer_unavailable", message: "Native action failed", delivery: attempted ? "unknown" : "not_delivered")
        }
    }
}
func verifyProcess(_ pid: pid_t, _ expected: String) throws {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
        "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)" == expected else { try fail("stale_reference", "Native process identity changed") }
}
func inputDeadline(_ request: [String: Any]) throws {
    guard let deadline = request["deadline_ms"] as? Double, Date().timeIntervalSince1970 * 1000 < deadline else { try fail("command_timeout", "Native input deadline expired") }
}
func focusedTarget(_ pid: pid_t, _ root: AXUIElement, _ element: AXUIElement?) throws {
    let app = AXUIElementCreateApplication(pid)
    guard let focusedWindow = attribute(app, kAXFocusedWindowAttribute), CFEqual(focusedWindow, root) else { try fail("foreground_changed", "Selected native window is not focused") }
    if let element = element {
        guard let focused = attribute(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute), CFEqual(focused, element) else { try fail("foreground_changed", "Selected native control is not focused") }
    }
}
func unobstructed(_ point: CGPoint, _ windowID: UInt32) throws {
    let all = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for other in all {
        if (other[kCGWindowNumber as String] as? UInt32) == windowID { return }
        if let dictionary = other[kCGWindowBounds as String] as? [String: Any], let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary), bounds.contains(point), (other[kCGWindowAlpha as String] as? Double ?? 1) > 0 { try fail("foreground_changed", "Another window covers the target") }
    }
    try fail("target_unavailable", "Native window is no longer visible")
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?; return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func text(_ element: AXUIElement, _ name: String) -> String { attribute(element, name) as? String ?? "" }
func axChildren(_ element: AXUIElement) -> [AXUIElement] { attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
func role(_ element: AXUIElement) -> String {
    let value = text(element, kAXRoleAttribute)
    return ["AXLandmarkNavigation":"navigation", "AXButton":"button", "AXLink":"link", "AXTextField":"textbox", "AXTextArea":"textbox", "AXCheckBox":"checkbox", "AXRadioButton":"radio", "AXHeading":"heading", "AXPopUpButton":"combobox" ][value] ?? value
}
func windows(_ pid: pid_t) -> [[String: Any]] {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return list.filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) && ($0[kCGWindowLayer as String] as? Int) == 0 }
}
func locateWindow(_ pid: pid_t, _ id: UInt32) throws -> [String: Any] {
    guard let window = windows(pid).first(where: { ($0[kCGWindowNumber as String] as? UInt32) == id }) else { try fail("target_unavailable", "Owned window is not visible") }
    return window
}
func axPID(_ element: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    return AXUIElementGetPid(element, &pid) == .success ? pid : nil
}
func axRect(_ element: AXUIElement) -> CGRect? {
    guard let position = attribute(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
        let size = attribute(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
        AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
    return CGRect(origin: point, size: dimensions)
}
func axRoot(_ pid: pid_t, _ info: [String: Any]) throws -> AXUIElement {
    guard AXIsProcessTrusted() else { try fail("observer_unavailable", "Accessibility permission is unavailable") }
    let app: AXUIElement = AXUIElementCreateApplication(pid)
    let all = attribute(app, kAXWindowsAttribute) as? [CFTypeRef] ?? []
    let title = info[kCGWindowName as String] as? String ?? ""
    guard let bounds = info[kCGWindowBounds as String] as? [String: Any],
        let expected = CGRect(dictionaryRepresentation: bounds as CFDictionary),
        [expected.minX, expected.minY, expected.width, expected.height].allSatisfy({ $0.isFinite }),
        expected.width > 0, expected.height > 0 else { try fail("target_unavailable", "Owned window geometry unavailable") }
    let matches: [AXUIElement] = all.compactMap { value in
        guard CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        let node = value as! AXUIElement // Checked CF type, never an application/title fallback.
        guard text(node, kAXRoleAttribute) == "AXWindow", axPID(node) == pid,
            text(node, kAXTitleAttribute) == title, let actual = axRect(node),
            [actual.minX, actual.minY, actual.width, actual.height].allSatisfy({ $0.isFinite }),
            actual.width > 0, actual.height > 0 else { return nil }
        // AX and CG window rectangles use global screen coordinates. Permit only
        // one point of rounding, never a nearest-window or title-only fallback.
        guard abs(actual.minX - expected.minX) <= 1, abs(actual.minY - expected.minY) <= 1,
            abs(actual.width - expected.width) <= 1, abs(actual.height - expected.height) <= 1 else { return nil }
        return node
    }
    guard matches.count == 1 else { try fail("ambiguous", "Native window cannot be matched uniquely to accessibility window") }
    return matches[0]
}
func inspectTree(_ root: AXUIElement) -> ([[String: Any]], [String: AXUIElement], Bool) {
    var elements: [[String: Any]] = [], refs: [String: AXUIElement] = [:], truncated = false
    var visited: [AXUIElement] = []
    func visit(_ node: AXUIElement, _ path: String, _ depth: Int, _ ancestors: [[String: String]]) {
        if elements.count >= 2000 || depth > 50 { truncated = true; return }
        if visited.contains(where: { CFEqual($0, node) }) { truncated = true; return }
        visited.append(node)
        let sensitive = text(node, kAXSubroleAttribute) == "AXSecureTextField"
        let label = [text(node, kAXTitleAttribute), text(node, kAXDescriptionAttribute), text(node, kAXHelpAttribute)].first { !$0.isEmpty } ?? ""
        var item: [String: Any] = ["ref": path, "role": role(node), "name": label, "sensitive": sensitive, "actions": ["click", "key"], "ancestors": ancestors]
        if !sensitive {
            if let value = attribute(node, kAXValueAttribute) as? String { item["value"] = value }
        }
        item["focused"] = (attribute(node, kAXFocusedAttribute) as? Bool) ?? false
        item["disabled"] = !((attribute(node, kAXEnabledAttribute) as? Bool) ?? true)
        let identity = "\(path)-\(CFHash(node))"; item["ref"] = identity
        refs[identity] = node; elements.append(item)
        for (index, child) in axChildren(node).enumerated() { visit(child, "\(path).\(index)", depth + 1, ancestors + [["role":role(node), "name":label]]) }
    }
    visit(root, "e0", 0, []); return (elements, refs, truncated)
}
func keyCode(_ key: String) -> CGKeyCode? {
    ["Enter":36,"Return":36,"Tab":48,"Space":49,"Escape":53,"Backspace":51,"Delete":117,"ArrowLeft":123,"Left":123,"ArrowRight":124,"Right":124,"ArrowDown":125,"Down":125,"ArrowUp":126,"Up":126,"Home":115,"End":119,"PageUp":116,"PageDown":121][key]
}
func pressKey(_ key: String, delivery: NativeDelivery) throws {
    let parts = key.split(separator: "+").map(String.init)
    let base = parts.last ?? key
    var flags: CGEventFlags = []
    for modifier in parts.dropLast() {
        switch modifier.lowercased() {
        case "command", "cmd", "meta": flags.insert(.maskCommand)
        case "control", "ctrl": flags.insert(.maskControl)
        case "alt", "option": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        default: try fail("unsupported_capability", "Unknown native key modifier")
        }
    }
    let letters: [String: CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"o":31,"u":32,"i":34,"p":35,"l":37,"j":38,"k":40,"n":45,"m":46]
    guard let code = keyCode(base) ?? letters[base.lowercased()], let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true), let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { try fail("unsupported_capability", "Unsupported native key") }
    down.flags = flags; up.flags = flags
    delivery.attempt { down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap) }
}
// Read-only diagnostic projection. Never changes input eligibility or requests access.
func focusDiagnostic(_ system: AXUIElement, _ name: String, _ ownedWindow: AXUIElement?) -> [String: Any] {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(system, name as CFString, &value)
    var result: [String: Any] = ["attribute_status": Int(status.rawValue)]
    guard status == .success, let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return result }
    let node = value as! AXUIElement // Type checked above, never accepts an arbitrary CF value.
    var pid: pid_t = 0
    let pidStatus = AXUIElementGetPid(node, &pid)
    result["pid_status"] = Int(pidStatus.rawValue)
    if pidStatus == .success && pid > 0 { result["pid"] = Int(pid) }
    var roleValue: CFTypeRef?
    let roleStatus = AXUIElementCopyAttributeValue(node, kAXRoleAttribute as CFString, &roleValue)
    result["role_status"] = Int(roleStatus.rawValue)
    if roleStatus == .success, let roleName = roleValue as? String {
        let allowed = ["AXApplication", "AXWindow", "AXButton", "AXTextField", "AXTextArea", "AXWebArea", "AXScrollArea", "AXGroup"]
        result["role"] = allowed.contains(roleName) ? roleName : "other"
    }
    if let ownedWindow = ownedWindow {
        var windowValue: CFTypeRef?
        let windowAttribute = name == kAXFocusedApplicationAttribute ? kAXFocusedWindowAttribute : kAXWindowAttribute
        let windowStatus = AXUIElementCopyAttributeValue(node, windowAttribute as CFString, &windowValue)
        result["window_status"] = Int(windowStatus.rawValue)
        if windowStatus == .success, let windowValue = windowValue, CFGetTypeID(windowValue) == AXUIElementGetTypeID() {
            result["owned_window_match"] = CFEqual(windowValue, ownedWindow)
        }
    }
    return result
}
func inputDiagnostics(_ request: [String: Any]) -> [String: Any] {
    var ownedWindow: AXUIElement?
    var ownedVerified = false
    let rawPID = request["pid"] as? Int
    let identity = request["start_identity"] as? String
    if let rawPID = rawPID, rawPID > 1 && rawPID <= Int(Int32.max), let identity = identity {
        do {
            let pid = pid_t(rawPID)
            try verifyProcess(pid, identity)
            ownedVerified = true
            if let id = request["diagnostic_window_id"] as? String, let windowID = UInt32(id),
                let info = try? locateWindow(pid, windowID) { ownedWindow = try? axRoot(pid, info) }
        } catch { /* Diagnostics cannot change doctor success or authority. */ }
    }
    let system = AXUIElementCreateSystemWide()
    var result: [String: Any] = ["schema": 1, "helper_pid": Int(getpid()),
        "post_event_access": CGPreflightPostEventAccess(),
        "frontmost_pid": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0),
        "selected_window_available": ownedWindow != nil,
        "focused_application": focusDiagnostic(system, kAXFocusedApplicationAttribute, ownedWindow),
        "focused_element": focusDiagnostic(system, kAXFocusedUIElementAttribute, ownedWindow)]
    if ownedVerified, let rawPID = rawPID, let identity = identity {
        do { try verifyProcess(pid_t(rawPID), identity) } catch { ownedVerified = false }
    }
    // All equality fields are observations only; false means their owned snapshot is stale/unavailable.
    result["owned_target_verified"] = ownedVerified
    if !ownedVerified {
        result["selected_window_available"] = false
        for field in ["focused_application", "focused_element"] {
            if var node = result[field] as? [String: Any] {
                node.removeValue(forKey: "owned_window_match")
                result[field] = node
            }
        }
    }
    return result
}
@main struct NativeControl {
    static func main() async {
        do {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            guard data.count <= 256 * 1024, let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { try fail("invalid_input", "Invalid native request") }
            let result = try await run(request)
            let output = try JSONSerialization.data(withJSONObject: ["ok":true,"result":result], options: [.sortedKeys])
            FileHandle.standardOutput.write(output)
        } catch {
            let failure = error as? NativeFailure
            let output: [String: Any] = ["ok":false,"delivery":failure?.delivery ?? "unknown","error":["code":failure?.code ?? "observer_unavailable", "message":failure?.message ?? "Native observer failed"]]
            if let data = try? JSONSerialization.data(withJSONObject: output) { FileHandle.standardOutput.write(data) }
        }
    }
    @MainActor static func run(_ request: [String: Any]) async throws -> [String: Any] {
        let command = request["command"] as? String ?? ""
        if command == "permission_setup" { return runPermissionChip(request) }
        if command == "doctor" {
            if request["request_accessibility"] as? Bool == true {
                _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            }
            return ["accessibility": AXIsProcessTrusted(), "screen_capture":CGPreflightScreenCaptureAccess(), "screens":NSScreen.screens.count, "input_diagnostics": inputDiagnostics(request)]
        }
        guard let rawPid = request["pid"] as? Int, rawPid > 1 else { try fail("invalid_input", "Exact owned PID required") }
        let pid = pid_t(rawPid)
        guard let expectedIdentity = request["start_identity"] as? String else { try fail("invalid_input", "Native process start identity required") }
        try verifyProcess(pid, expectedIdentity)
        if command == "targets" { return ["windows": windows(pid).map { info in ["window_id": String(info[kCGWindowNumber as String] as? UInt32 ?? 0), "title": info[kCGWindowName as String] as? String ?? "", "bounds":info[kCGWindowBounds as String] ?? [:]] }] }
        guard let rawWindow = request["window_id"] as? String, let windowID = UInt32(rawWindow) else { try fail("invalid_input", "Window ID required") }
        let info = try locateWindow(pid, windowID)
        if command == "capture" {
            guard CGPreflightScreenCaptureAccess() else { try fail("observer_unavailable", "Screen capture permission unavailable") }
            guard #available(macOS 14.0, *) else { try fail("unsupported_capability", "Window capture requires macOS 14") }
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            guard let window = content.windows.first(where: {$0.windowID == windowID && $0.owningApplication?.processID == pid}) else { try fail("target_unavailable", "Owned capture window disappeared") }
            let config = SCStreamConfiguration()
            let display = content.displays.first { CGDisplayBounds($0.displayID).intersects(window.frame) }
            let scale = display.map { Double(CGDisplayPixelsWide($0.displayID)) / CGDisplayBounds($0.displayID).width } ?? 1
            config.width = Int(window.frame.width * scale); config.height = Int(window.frame.height * scale); config.showsCursor = false
            guard config.width > 0 && config.height > 0 && config.width <= 16384 && config.height <= 16384 else { try fail("capture_invalid", "Image dimensions exceed limit") }
            try verifyProcess(pid, expectedIdentity)
            let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config)
            let rep = NSBitmapImageRep(cgImage: image)
            guard let png = rep.representation(using: .png, properties: [:]), png.count <= 16 * 1024 * 1024 else { try fail("capture_invalid", "PNG unavailable or too large") }
            return ["png":png.base64EncodedString(), "width":image.width, "height":image.height, "scale":scale]
        }
        let root = try axRoot(pid, info)
        let (elements, refs, truncated) = inspectTree(root)
        if command == "inspect" { return ["elements":elements,"truncated":truncated] }
        guard command == "act", let action = request["action"] as? [String: Any], let kind = action["kind"] as? String else { try fail("invalid_input", "Unknown native command") }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid || kind == "activate" else { try fail("foreground_changed", "Owned application lost foreground; activate then inspect") }
        let element = (action["ref"] as? String).flatMap {refs[$0]}
        if action["ref"] != nil && element == nil { try fail("stale_reference", "Selected native control disappeared") }
        try verifyProcess(pid, expectedIdentity)
        try inputDeadline(request)
        let delivery = NativeDelivery()
        return try delivery.run {
            switch kind {
            case "activate":
                guard delivery.attempt({ NSRunningApplication(processIdentifier: pid)?.activate(options: []) }) == true,
                    delivery.attempt({ AXUIElementPerformAction(root, kAXRaiseAction as CFString) }) == .success else { try fail("target_unavailable", "Selected window activation failed") }
            case "click":
                if let x = action["x"] as? Double, let y = action["y"] as? Double {
                    guard let expected = request["expected_bounds"] as? [String: Double], let actual = info[kCGWindowBounds as String] as? [String: Double],
                        expected["x"] == actual["X"], expected["y"] == actual["Y"], expected["width"] == actual["Width"], expected["height"] == actual["Height"] else { try fail("stale_reference", "Window moved since capture") }
                    let point = CGPoint(x: x, y: y)
                    try unobstructed(point, windowID)
                    try verifyProcess(pid, expectedIdentity); try inputDeadline(request)
                    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left), let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { try fail("observer_unavailable", "Mouse events unavailable") }
                    delivery.attempt { down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap) }
                } else {
                    guard let node = element else { try fail("stale_reference", "Selected native control unavailable") }
                    guard delivery.attempt({ AXUIElementPerformAction(node, kAXPressAction as CFString) }) == .success else { try fail("unsupported_capability", "Control has no press action") }
                }
            case "type", "select":
                guard let node = element, text(node, kAXSubroleAttribute) != "AXSecureTextField" else { try fail("sensitive_input", "Text entry requires a non-secret control") }
                let value = action[kind == "type" ? "text" : "value"] as? String ?? ""
                guard delivery.attempt({ AXUIElementSetAttributeValue(node, kAXValueAttribute as CFString, value as CFString) }) == .success else { try fail("unsupported_capability", "Control value is not writable") }
            case "resize":
                guard let width = action["width"] as? Double, let height = action["height"] as? Double, width > 0, height > 0, width <= 16384, height <= 16384 else { try fail("invalid_input", "Invalid window size") }
                var size = CGSize(width: width, height: height)
                guard let value = AXValueCreate(.cgSize, &size) else { try fail("unsupported_capability", "Window size unavailable") }
                guard delivery.attempt({ AXUIElementSetAttributeValue(root, kAXSizeAttribute as CFString, value) }) == .success else { try fail("unsupported_capability", "Window cannot be resized") }
            case "scroll":
                if element != nil { try fail("unsupported_capability", "Use a window scroll after inspecting its current focus") }
                let dy = action["delta_y"] as? Double ?? 400
                let dx = action["delta_x"] as? Double ?? 0
                guard abs(dy) <= 16384 && abs(dx) <= 16384 else { try fail("invalid_input", "Scroll delta too large") }
                guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(-dy), wheel2: Int32(-dx), wheel3: 0) else { try fail("observer_unavailable", "Scroll event unavailable") }
                guard let dictionary = info[kCGWindowBounds as String] as? [String: Any], let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary) else { try fail("target_unavailable", "Window bounds unavailable") }
                let point = CGPoint(x: bounds.midX, y: bounds.midY)
                try unobstructed(point, windowID)
                try focusedTarget(pid, root, nil)
                try verifyProcess(pid, expectedIdentity); try inputDeadline(request)
                guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else { try fail("observer_unavailable", "Pointer event unavailable") }
                delivery.attempt {
                    move.post(tap: .cghidEventTap)
                    event.location = point
                    event.post(tap: .cghidEventTap)
                }
            case "key":
                try focusedTarget(pid, root, element)
                try verifyProcess(pid, expectedIdentity); try inputDeadline(request)
                try pressKey(action["key"] as? String ?? "", delivery: delivery)
            default: try fail("unsupported_capability", "Native action not supported by this control")
            }
            return ["delivery":"delivered"]
        }
    }
}
