import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit

struct NativeFailure: Error { let code: String; let message: String }
func fail(_ code: String, _ message: String) throws -> Never { throw NativeFailure(code: code, message: message) }
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
func axRoot(_ pid: pid_t, _ info: [String: Any]) throws -> AXUIElement {
    guard AXIsProcessTrusted() else { try fail("observer_unavailable", "Accessibility permission is unavailable") }
    let app = AXUIElementCreateApplication(pid)
    let all = attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
    let title = info[kCGWindowName as String] as? String ?? ""
    let matches = all.filter { text($0, kAXTitleAttribute) == title }
    guard matches.count == 1 else { try fail("ambiguous", "Native window cannot be matched uniquely to accessibility window") }
    return matches[0]
}
func inspectTree(_ root: AXUIElement) -> ([[String: Any]], [String: AXUIElement], Bool) {
    var elements: [[String: Any]] = [], refs: [String: AXUIElement] = [:], truncated = false
    func visit(_ node: AXUIElement, _ path: String, _ depth: Int, _ ancestors: [[String: String]]) {
        if elements.count >= 2000 || depth > 50 { truncated = true; return }
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
func pressKey(_ key: String) throws {
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
    down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
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
            let output: [String: Any] = ["ok":false,"error":["code":failure?.code ?? "observer_unavailable", "message":failure?.message ?? "Native observer failed"]]
            if let data = try? JSONSerialization.data(withJSONObject: output) { FileHandle.standardOutput.write(data) }
        }
    }
    @MainActor static func run(_ request: [String: Any]) async throws -> [String: Any] {
        let command = request["command"] as? String ?? ""
        if command == "doctor" {
            return ["accessibility": AXIsProcessTrusted(), "screen_capture":CGPreflightScreenCaptureAccess(), "screens":NSScreen.screens.count]
        }
        guard let rawPid = request["pid"] as? Int, rawPid > 1 else { try fail("invalid_input", "Exact owned PID required") }
        let pid = pid_t(rawPid)
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
        switch kind {
        case "activate": guard NSRunningApplication(processIdentifier: pid)?.activate(options: []) == true else { try fail("target_unavailable", "Activation failed") }
        case "click":
            if let x = action["x"] as? Double, let y = action["y"] as? Double {
                guard let expected = request["expected_bounds"] as? [String: Double], let actual = info[kCGWindowBounds as String] as? [String: Double],
                    expected["x"] == actual["X"], expected["y"] == actual["Y"], expected["width"] == actual["Width"], expected["height"] == actual["Height"] else { try fail("stale_reference", "Window moved since capture") }
                let point = CGPoint(x: x, y: y)
                let all = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
                for other in all {
                    if (other[kCGWindowNumber as String] as? UInt32) == windowID { break }
                    if let dictionary = other[kCGWindowBounds as String] as? [String: Any], let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary), bounds.contains(point), (other[kCGWindowAlpha as String] as? Double ?? 1) > 0 { try fail("foreground_changed", "Another window covers the coordinate") }
                }
                guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left), let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { try fail("observer_unavailable", "Mouse events unavailable") }
                down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
            } else {
                guard let node = element, AXUIElementPerformAction(node, kAXPressAction as CFString) == .success else { try fail("unsupported_capability", "Control has no press action") }
            }
        case "type", "select":
            guard let node = element, text(node, kAXSubroleAttribute) != "AXSecureTextField" else { try fail("sensitive_input", "Text entry requires a non-secret control") }
            let value = action[kind == "type" ? "text" : "value"] as? String ?? ""
            guard AXUIElementSetAttributeValue(node, kAXValueAttribute as CFString, value as CFString) == .success else { try fail("unsupported_capability", "Control value is not writable") }
        case "resize":
            guard let width = action["width"] as? Double, let height = action["height"] as? Double, width > 0, height > 0, width <= 16384, height <= 16384 else { try fail("invalid_input", "Invalid window size") }
            var size = CGSize(width: width, height: height)
            guard let value = AXValueCreate(.cgSize, &size), AXUIElementSetAttributeValue(root, kAXSizeAttribute as CFString, value) == .success else { try fail("unsupported_capability", "Window cannot be resized") }
        case "scroll":
            let dy = action["delta_y"] as? Double ?? 400
            let dx = action["delta_x"] as? Double ?? 0
            guard abs(dy) <= 16384 && abs(dx) <= 16384 else { try fail("invalid_input", "Scroll delta too large") }
            guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(-dy), wheel2: Int32(-dx), wheel3: 0) else { try fail("observer_unavailable", "Scroll event unavailable") }
            event.post(tap: .cghidEventTap)
        case "key": try pressKey(action["key"] as? String ?? "")
        default: try fail("unsupported_capability", "Native action not supported by this control")
        }
        return ["delivery":"delivered"]
    }
}
