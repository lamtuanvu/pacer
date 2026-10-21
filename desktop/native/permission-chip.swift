import Foundation
import AppKit
import ApplicationServices
import Darwin

struct PermissionChipPlacement {
    let frame: CGRect
    let compact: Bool
}

/// Settings/visible rectangles use AppKit coordinates, including negative display origins.
func permissionChipPlacement(settings: CGRect, visible: CGRect, preferred: CGSize) -> PermissionChipPlacement {
    let safe = visible.insetBy(dx: 8, dy: 8)
    let size = CGSize(width: min(preferred.width, safe.width), height: min(preferred.height, safe.height))
    let y = min(max(settings.maxY - size.height, safe.minY), safe.maxY - size.height)
    let right = CGRect(x: settings.maxX + 12, y: y, width: size.width, height: size.height)
    if safe.contains(right) { return PermissionChipPlacement(frame: right, compact: false) }
    let left = CGRect(x: settings.minX - size.width - 12, y: y, width: size.width, height: size.height)
    if safe.contains(left) { return PermissionChipPlacement(frame: left, compact: false) }
    let above = CGRect(x: min(max(settings.minX, safe.minX), safe.maxX-size.width), y: settings.maxY+12, width:size.width, height:size.height)
    if safe.contains(above) { return PermissionChipPlacement(frame: above, compact: false) }
    let below = CGRect(x: above.minX, y: settings.minY-size.height-12, width:size.width, height:size.height)
    if safe.contains(below) { return PermissionChipPlacement(frame: below, compact: false) }
    // A maximized Settings window leaves no exterior slot. Stay over its top-left
    // navigation/header area with a compact target rather than clipping off-screen.
    let compact = CGSize(width: min(260, safe.width), height: min(104, safe.height))
    let x = min(max(settings.minX + 12, safe.minX), safe.maxX-compact.width)
    return PermissionChipPlacement(frame:CGRect(x:x,y:min(max(settings.maxY-compact.height-12,safe.minY),safe.maxY-compact.height),width:compact.width,height:compact.height),compact:true)
}

/// The outer application owns embedded helpers; never offer an inner helper bundle.
func permissionHostingBundlePath(_ executable: String) -> String? {
    let components = (executable as NSString).pathComponents
    guard let index = components.firstIndex(where: {$0.hasSuffix(".app")}) else { return nil }
    return NSString.path(withComponents:Array(components[...index]))
}

enum PermissionChipLeaseError: Error { case busy, unavailable }
final class PermissionChipLease {
    private let descriptor: Int32
    init(targetPID: pid_t) throws {
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent("pacer-native-validation",isDirectory:true)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let path=directory.appendingPathComponent("setup-\(getuid())-\(targetPID).lock").path
        let descriptor=Darwin.open(path,O_CREAT|O_RDWR|O_CLOEXEC|O_NOFOLLOW,mode_t(0o600))
        guard descriptor>=0 else { throw PermissionChipLeaseError.unavailable }
        var metadata=stat()
        guard fstat(descriptor,&metadata)==0,metadata.st_uid==getuid(),metadata.st_mode & mode_t(S_IFMT)==mode_t(S_IFREG),metadata.st_mode & 0o077==0 else {
            Darwin.close(descriptor);throw PermissionChipLeaseError.unavailable
        }
        guard flock(descriptor,LOCK_EX|LOCK_NB)==0 else { Darwin.close(descriptor);throw PermissionChipLeaseError.busy }
        self.descriptor=descriptor
    }
    deinit { _=flock(descriptor,LOCK_UN);Darwin.close(descriptor) }
}

func permissionProcessIdentity(_ pid: pid_t) -> String? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard pid > 1, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
    return "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)"
}

func permissionLauncherIsAlive(_ pid: pid_t, identity: String?) -> Bool {
    guard let identity=identity else { return false }
    return permissionProcessIdentity(pid)==identity
}

// Directly launched apps inherit the outer hosting app’s responsibility.
// Continue past a nested desktop process; LaunchServices roots naturally end at launchd.
func permissionHostingBundle() -> URL? {
    var pid = getppid()
    var host:URL?
    for _ in 0..<32 {
        guard pid > 1 else { break }
        var path = [CChar](repeating:0,count:4 * Int(MAXPATHLEN))
        if proc_pidpath(pid,&path,UInt32(path.count)) > 0,
           let outer = permissionHostingBundlePath(String(decoding:path.prefix(while:{$0 != 0}).map { UInt8(bitPattern:$0) },as:UTF8.self)),
           let bundle = Bundle(url:URL(fileURLWithPath:outer)), bundle.bundleIdentifier != nil {
            host=bundle.bundleURL.resolvingSymlinksInPath()
        }
        // Full BSD process info can be denied across the root-owned login process.
        // The public short-info flavor exposes only the ancestry needed here.
        var info = proc_bsdshortinfo()
        let size = Int32(MemoryLayout<proc_bsdshortinfo>.size)
        guard proc_pidinfo(pid,PROC_PIDT_SHORTBSDINFO,0,&info,size) == size, info.pbsi_ppid != pid else { break }
        pid = pid_t(info.pbsi_ppid)
    }
    return host
}

@MainActor final class PermissionAppDragView: NSView, NSDraggingSource {
    let appURL: URL
    let appName: String
    var draggingChanged: ((Bool)->Void)?
    init(appURL:URL,name:String) {
        self.appURL=appURL;self.appName=name
        super.init(frame:.zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        setAccessibilityLabel("Drag \(name) into the Accessibility applications list")
        setAccessibilityHelp("Hosting app inferred from process ancestry. Use Show app for a keyboard-accessible Finder alternative")
    }
    required init?(coder:NSCoder) { fatalError("init(coder:) is unavailable") }
    override func draw(_ dirtyRect:NSRect) {
        NSColor.controlBackgroundColor.setFill()
        NSBezierPath(roundedRect:bounds.insetBy(dx:0.5,dy:0.5),xRadius:9,yRadius:9).fill()
        NSColor.separatorColor.setStroke()
        NSBezierPath(roundedRect:bounds.insetBy(dx:0.5,dy:0.5),xRadius:9,yRadius:9).stroke()
        NSWorkspace.shared.icon(forFile:appURL.path).draw(in:NSRect(x:10,y:(bounds.height-36)/2,width:36,height:36))
        (appName as NSString).draw(in:NSRect(x:55,y:bounds.midY-1,width:bounds.width-65,height:20),withAttributes:[.font:NSFont.systemFont(ofSize:13,weight:.medium),.foregroundColor:NSColor.labelColor])
        ("Inferred host · drag into list" as NSString).draw(in:NSRect(x:55,y:bounds.midY-18,width:bounds.width-65,height:17),withAttributes:[.font:NSFont.systemFont(ofSize:11),.foregroundColor:NSColor.labelColor])
    }
    override func mouseDown(with event:NSEvent) {
        // Use the dedicated dragging pasteboard; never read or change the clipboard.
        let item=NSDraggingItem(pasteboardWriter:appURL as NSURL)
        item.setDraggingFrame(NSRect(x:10,y:(bounds.height-36)/2,width:36,height:36),contents:NSWorkspace.shared.icon(forFile:appURL.path))
        draggingChanged?(true)
        beginDraggingSession(with:[item],event:event,source:self)
    }
    func draggingSession(_ session:NSDraggingSession,sourceOperationMaskFor context:NSDraggingContext)->NSDragOperation { .copy }
    func draggingSession(_ session:NSDraggingSession,endedAt point:NSPoint,operation:NSDragOperation) { draggingChanged?(false) }
}

@MainActor final class PermissionSetupPanel:NSPanel {
    override var canBecomeKey:Bool { true }
    override var canBecomeMain:Bool { false }
}

@MainActor final class PermissionChipController:NSObject,NSWindowDelegate {
    let panel=PermissionSetupPanel(contentRect:NSRect(x:0,y:0,width:320,height:164),styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
    let appURL:URL
    let targetPID:pid_t
    let targetIdentity:String
    let launcherPID=getppid()
    let launcherIdentity=permissionProcessIdentity(getppid())
    let deadline:TimeInterval
    let title=NSTextField(labelWithString:"Drag this app into the list")
    let hint=NSTextField(labelWithString:"Then enable its switch in Settings")
    let drag:PermissionAppDragView
    let reveal=NSButton(title:"Show app",target:nil,action:nil)
    let cancel=NSButton(title:"Cancel",target:nil,action:nil)
    var timer:Timer?
    var selectedSettingsPID:pid_t?
    var selectedWindow:UInt32?
    var missingSince:TimeInterval?
    var compact=false
    var isDragging=false
    var result:[String:Any]=["status":"cancelled"]
    var finished=false
    var ticks=0
    let started=Date().timeIntervalSince1970
    init(appURL:URL,targetPID:pid_t,identity:String,timeout:Double) {
        self.appURL=appURL;self.targetPID=targetPID;self.targetIdentity=identity
        self.deadline=Date().timeIntervalSince1970+min(max(timeout,1),300)
        let bundle=Bundle(url:appURL)
        let name=(bundle?.object(forInfoDictionaryKey:"CFBundleDisplayName") as? String) ?? (bundle?.object(forInfoDictionaryKey:"CFBundleName") as? String) ?? appURL.deletingPathExtension().lastPathComponent
        drag=PermissionAppDragView(appURL:appURL,name:name)
        super.init()
        panel.delegate=self;panel.isReleasedWhenClosed=false;panel.level = .floating
        panel.isFloatingPanel=true;panel.hidesOnDeactivate=false;panel.hasShadow=true;panel.becomesKeyOnlyIfNeeded=true
        panel.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary]
        panel.title="Enable native validation"
        panel.backgroundColor = .windowBackgroundColor
        panel.contentView?.wantsLayer=true;panel.contentView?.layer?.cornerRadius=12
        title.font = .systemFont(ofSize:13,weight:.medium)
        hint.font = .systemFont(ofSize:11);hint.textColor = .labelColor
        for view in [title,hint,drag,reveal,cancel] { panel.contentView?.addSubview(view) }
        reveal.target=self;reveal.action=#selector(showApp);reveal.bezelStyle = .rounded
        cancel.target=self;cancel.action=#selector(cancelSetup);cancel.bezelStyle = .rounded;cancel.keyEquivalent="\u{1b}"
        drag.draggingChanged={ [weak self] value in self?.isDragging=value }
        layout(compact:false)
    }
    func layout(compact:Bool) {
        self.compact=compact
        title.isHidden=compact;hint.isHidden=compact
        let width=panel.frame.width,height=panel.frame.height
        title.frame=NSRect(x:16,y:height-30,width:width-32,height:20)
        hint.frame=NSRect(x:16,y:height-48,width:width-32,height:17)
        drag.frame=NSRect(x:12,y:40,width:width-24,height:compact ? height-48:62)
        reveal.frame=NSRect(x:12,y:7,width:90,height:28)
        cancel.frame=NSRect(x:width-87,y:7,width:75,height:28)
    }
    @objc func showApp() { NSWorkspace.shared.activateFileViewerSelecting([appURL]) }
    @objc func cancelSetup() { finish("cancelled") }
    func windowShouldClose(_ sender:NSWindow)->Bool { finish("cancelled");return false }
    func finish(_ status:String) {
        guard !finished else { return }
        finished=true;timer?.invalidate();timer=nil;panel.orderOut(nil)
        result=["status":status,"accessibility":AXIsProcessTrusted(),"host_app":appURL.path,"host_attribution":"process_ancestry","target_pid":Int(targetPID)]
        NSApplication.shared.stop(nil)
        if let wake=NSEvent.otherEvent(with:.applicationDefined,location:.zero,modifierFlags:[],timestamp:0,windowNumber:0,context:nil,subtype:0,data1:0,data2:0) { NSApplication.shared.postEvent(wake,atStart:false) }
    }
    func probeOwnedAccess()->Bool {
        guard AXIsProcessTrusted(),permissionProcessIdentity(targetPID)==targetIdentity else { return false }
        var value:CFTypeRef?
        let status=AXUIElementCopyAttributeValue(AXUIElementCreateApplication(targetPID),kAXWindowsAttribute as CFString,&value)
        return status == .success && !(value as? [AXUIElement] ?? []).isEmpty
    }
    @objc func timerFired(_ timer:Timer) { tick() }
    func tick() {
        guard !finished else { return }
        if !permissionLauncherIsAlive(launcherPID,identity:launcherIdentity) { finish("cancelled");return }
        if Date().timeIntervalSince1970>=deadline { finish("timeout");return }
        if permissionProcessIdentity(targetPID) != targetIdentity { finish("target_exited");return }
        ticks += 1
        if Date().timeIntervalSince1970-started>30 {
            title.stringValue="Waiting for native access"
            hint.stringValue="Check switch; save work before reopening"
        }
        if !isDragging && ticks % 5 == 0 && probeOwnedAccess() { finish("verified");return }
        guard !isDragging else { return }
        guard let settings=NSWorkspace.shared.runningApplications.first(where:{$0.bundleIdentifier=="com.apple.systempreferences"}) else {
            if Date().timeIntervalSince1970-started>10 { finish("settings_closed") };return
        }
        if let selectedSettingsPID=selectedSettingsPID, selectedSettingsPID != settings.processIdentifier { finish("settings_closed");return }
        selectedSettingsPID=settings.processIdentifier
        let list=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
        let windows=list.filter { info in
            guard info[kCGWindowOwnerPID as String] as? Int == Int(settings.processIdentifier),info[kCGWindowLayer as String] as? Int == 0,
                let dict=info[kCGWindowBounds as String] as? [String:Any],let frame=CGRect(dictionaryRepresentation:dict as CFDictionary) else { return false }
            return frame.width>300 && frame.height>200
        }
        let window=selectedWindow.flatMap { id in windows.first(where:{$0[kCGWindowNumber as String] as? UInt32 == id}) } ?? (selectedWindow == nil ? windows.first:nil)
        guard let window=window,let dict=window[kCGWindowBounds as String] as? [String:Any],let cg=CGRect(dictionaryRepresentation:dict as CFDictionary),let primary=NSScreen.screens.first else {
            panel.orderOut(nil)
            if let selectedWindow=selectedWindow {
                let all=CGWindowListCopyWindowInfo([.optionAll,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
                if all.contains(where:{$0[kCGWindowOwnerPID as String] as? Int == Int(settings.processIdentifier) && $0[kCGWindowNumber as String] as? UInt32 == selectedWindow}) {
                    missingSince=nil;return // Minimized or on another Space: remain available.
                }
            }
            if missingSince == nil { missingSince=Date().timeIntervalSince1970 }
            if Date().timeIntervalSince1970-(missingSince ?? started)>3 && selectedWindow != nil { finish("settings_closed") }
            if selectedWindow == nil && Date().timeIntervalSince1970-started>10 { finish("settings_unavailable") }
            return
        }
        missingSince=nil;selectedWindow=window[kCGWindowNumber as String] as? UInt32
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == settings.processIdentifier else { panel.orderOut(nil);return }
        let frame=CGRect(x:cg.minX,y:primary.frame.maxY-cg.maxY,width:cg.width,height:cg.height)
        let display=NSScreen.screens.max { a,b in a.frame.intersection(frame).width*a.frame.intersection(frame).height < b.frame.intersection(frame).width*b.frame.intersection(frame).height } ?? primary
        let placement=permissionChipPlacement(settings:frame,visible:display.visibleFrame,preferred:CGSize(width:320,height:164))
        if panel.frame != placement.frame { panel.setFrame(placement.frame,display:true,animate:false) }
        layout(compact:placement.compact)
        panel.orderFrontRegardless()
    }
    func run()->[String:Any] {
        _=NSApplication.shared.setActivationPolicy(.accessory)
        let url=URL(string:"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
        guard NSWorkspace.shared.open(url) else { return ["status":"settings_unavailable"] }
        // The OS may suppress this prompt. The app chip remains a direct fallback.
        _=AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary)
        // An AppKit run-loop timer avoids a Swift Concurrency runtime requirement
        // on the shell's macOS 11 deployment floor.
        let tick=Timer(timeInterval:0.1,target:self,selector:#selector(timerFired(_:)),userInfo:nil,repeats:true)
        timer=tick;RunLoop.main.add(tick,forMode:.common)
        NSApplication.shared.run()
        tick.invalidate();timer=nil;panel.orderOut(nil)
        return result
    }
}

@MainActor func runPermissionChip(_ request:[String:Any])->[String:Any] {
    guard let raw=request["pid"] as? Int,raw>1,let identity=request["start_identity"] as? String,
        permissionProcessIdentity(pid_t(raw))==identity else { return ["status":"target_unavailable"] }
    guard let bundle=permissionHostingBundle() else { return ["status":"host_unknown","message":"Run setup from an application such as your terminal or agent host."] }
    let lease:PermissionChipLease
    do { lease=try PermissionChipLease(targetPID:pid_t(raw)) }
    catch PermissionChipLeaseError.busy { return ["status":"already_open"] }
    catch { return ["status":"setup_unavailable"] }
    let controller=PermissionChipController(appURL:bundle,targetPID:pid_t(raw),identity:identity,timeout:(request["timeout_ms"] as? Double ?? 180000)/1000)
    return withExtendedLifetime(lease) { controller.run() }
}
