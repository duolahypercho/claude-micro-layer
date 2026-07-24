import ApplicationServices
import Carbon.HIToolbox
import Cocoa

private let claudeBundleIdentifier = "com.anthropic.claudefordesktop"
private let fallbackClaudeURL = URL(fileURLWithPath: "/Applications/Claude.app")
private let hotKeySignature: OSType = 0x434D4643 // CMFC
private let hotKeyModifiers = UInt32(controlKey | optionKey | cmdKey)

private enum ClaudeCommand: UInt32 {
    case focus = 1
    case recent1
    case recent2
    case recent3
    case recent4
    case recent5
    case recent6
    case fastMode
    case confirm
    case cancel
    case fork
    case voice
    case zoomOut
    case zoomIn
    case actualSize
    case newChat
}

private struct HotKeyBinding {
    let command: ClaudeCommand
    let keyCode: UInt32
    // Most controls use the private Control-Option-Command prefix. Voice is the
    // exception: it needs a bare key so the firmware holds it for as long as the
    // physical key is down, which is what makes push-to-talk possible.
    var modifiers: UInt32 = hotKeyModifiers
}

private let hotKeyBindings = [
    HotKeyBinding(command: .focus, keyCode: UInt32(kVK_ANSI_C)),
    HotKeyBinding(command: .recent1, keyCode: UInt32(kVK_ANSI_1)),
    HotKeyBinding(command: .recent2, keyCode: UInt32(kVK_ANSI_2)),
    HotKeyBinding(command: .recent3, keyCode: UInt32(kVK_ANSI_3)),
    HotKeyBinding(command: .recent4, keyCode: UInt32(kVK_ANSI_4)),
    HotKeyBinding(command: .recent5, keyCode: UInt32(kVK_ANSI_5)),
    HotKeyBinding(command: .recent6, keyCode: UInt32(kVK_ANSI_6)),
    HotKeyBinding(command: .fastMode, keyCode: UInt32(kVK_ANSI_F)),
    HotKeyBinding(command: .confirm, keyCode: UInt32(kVK_ANSI_Y)),
    HotKeyBinding(command: .cancel, keyCode: UInt32(kVK_ANSI_X)),
    HotKeyBinding(command: .fork, keyCode: UInt32(kVK_ANSI_K)),
    HotKeyBinding(command: .voice, keyCode: UInt32(kVK_F18), modifiers: 0),
    HotKeyBinding(command: .zoomOut, keyCode: UInt32(kVK_ANSI_Minus)),
    HotKeyBinding(command: .zoomIn, keyCode: UInt32(kVK_ANSI_Equal)),
    HotKeyBinding(command: .actualSize, keyCode: UInt32(kVK_ANSI_0)),
    HotKeyBinding(command: .newChat, keyCode: UInt32(kVK_ANSI_N)),
]

private var registeredHotKeys: [EventHotKeyRef] = []
private var lastNonFastEffort: Double = 2

func runningClaude() -> NSRunningApplication? {
    NSRunningApplication.runningApplications(
        withBundleIdentifier: claudeBundleIdentifier
    ).first
}

private func openClaude(activate: Bool, completion: @escaping (NSRunningApplication?) -> Void) {
    if let application = runningClaude() {
        completion(application)
        return
    }

    let workspace = NSWorkspace.shared
    let applicationURL = workspace.urlForApplication(
        withBundleIdentifier: claudeBundleIdentifier
    ) ?? fallbackClaudeURL
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = activate
    workspace.openApplication(at: applicationURL, configuration: configuration) {
        application, _ in
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            completion(application ?? runningClaude())
        }
    }
}

private func activateClaude() {
    openClaude(activate: true) { application in
        application?.unhide()
        application?.activate(options: [.activateAllWindows])
    }
}

private func hasAccessibilityPermission() -> Bool {
    if AXIsProcessTrusted() {
        return true
    }

    let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    AXIsProcessTrustedWithOptions([promptKey: true] as CFDictionary)
    return false
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
        return nil
    }
    return value
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
    attribute(element, name) as? String
}

func elementLabel(_ element: AXUIElement) -> String {
    for name in [
        kAXTitleAttribute,
        kAXDescriptionAttribute,
        kAXHelpAttribute,
        kAXValueAttribute,
    ] {
        if let value = stringAttribute(element, name), !value.isEmpty {
            return value
        }
    }
    return ""
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

func isEnabled(_ element: AXUIElement) -> Bool {
    (attribute(element, kAXEnabledAttribute) as? Bool) ?? true
}

func isPressable(_ element: AXUIElement) -> Bool {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else {
        return false
    }
    return (names as? [String])?.contains(kAXPressAction as String) ?? false
}

func allElements(_ application: NSRunningApplication) -> [AXUIElement] {
    let root = AXUIElementCreateApplication(application.processIdentifier)
    var pending = [root]
    var pendingIndex = 0
    var result: [AXUIElement] = []
    var visited = Set<CFHashCode>()

    while pendingIndex < pending.count && result.count < 5_000 {
        let element = pending[pendingIndex]
        pendingIndex += 1
        let hash = CFHash(element)
        if visited.contains(hash) {
            continue
        }
        visited.insert(hash)
        result.append(element)
        pending.append(contentsOf: children(element))
    }
    return result
}

func normalized(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

private func pressElement(_ element: AXUIElement) -> Bool {
    isEnabled(element) &&
        AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
}

private func pressControl(
    in application: NSRunningApplication,
    labels: [String],
    preferLast: Bool = false,
    exactOnly: Bool = false
) -> Bool {
    let wanted = labels.map(normalized)
    let matches = allElements(application).filter { element in
        guard isPressable(element), isEnabled(element) else { return false }
        let label = normalized(elementLabel(element))
        if wanted.contains(label) { return true }
        // Prefix matching finds labels like "Approve running npm test", but it
        // would also match unrelated controls such as "Send feedback", so the
        // caller can require an exact label.
        return exactOnly ? false : wanted.contains { label.hasPrefix("\($0) ") }
    }
    guard let target = preferLast ? matches.last : matches.first else {
        return false
    }
    return pressElement(target)
}

private func sendKey(
    _ keyCode: CGKeyCode,
    flags: CGEventFlags = [],
    to application: NSRunningApplication
) {
    guard
        let source = CGEventSource(stateID: .hidSystemState),
        let keyDown = CGEvent(
            keyboardEventSource: source,
            virtualKey: keyCode,
            keyDown: true
        ),
        let keyUp = CGEvent(
            keyboardEventSource: source,
            virtualKey: keyCode,
            keyDown: false
        )
    else {
        return
    }
    keyDown.flags = flags
    keyUp.flags = flags
    keyDown.postToPid(application.processIdentifier)
    keyUp.postToPid(application.processIdentifier)
}

// Claude's dictation is Command-D, which toggles recording. The voice key is
// held to talk, so the press starts recording and the matching release sends
// the same shortcut again to stop it.
private var voiceRecording = false

private func toggleDictation(in application: NSRunningApplication) {
    sendKey(CGKeyCode(kVK_ANSI_D), flags: .maskCommand, to: application)
}

private func activateVoiceControl(in application: NSRunningApplication) {
    toggleDictation(in: application)
    voiceRecording = true
    lightsLog("dictation started")
}

func stopVoiceControl() {
    guard voiceRecording else { return }
    voiceRecording = false
    guard let application = runningClaude() else { return }
    toggleDictation(in: application)
    lightsLog("dictation stopped")
}

// Verified against Claude Desktop 1.24012.1: sidebar recents are AXButtons
// labeled "<Status> <chat title>", currently "Running" or "Idle". The extra
// prefixes cover states that appear only transiently.
let recentStatusPrefixes = [
    "running ",
    "idle ",
    "unread ",
    "working ",
    "awaiting approval ",
    "awaiting response ",
    "needs attention ",
    "error ",
]

func recentTaskButtons(in application: NSRunningApplication) -> [AXUIElement] {
    allElements(application).filter { element in
        guard
            stringAttribute(element, kAXRoleAttribute) == (kAXButtonRole as String),
            isPressable(element),
            isEnabled(element)
        else {
            return false
        }
        let label = normalized(elementLabel(element))
        return recentStatusPrefixes.contains { label.hasPrefix($0) }
    }
    // The accessibility tree is walked breadth-first, so its order follows the
    // view hierarchy rather than the sidebar. Sort by screen position so slot N
    // is the Nth chat the user actually sees, and the key matches its light.
    .sorted { first, second in
        let left = elementOrigin(first)
        let right = elementOrigin(second)
        return left.y == right.y ? left.x < right.x : left.y < right.y
    }
}

private func elementOrigin(_ element: AXUIElement) -> CGPoint {
    var value: CFTypeRef?
    guard
        AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &value)
            == .success,
        let positionValue = value,
        CFGetTypeID(positionValue) == AXValueGetTypeID()
    else {
        return CGPoint(
            x: CGFloat.greatestFiniteMagnitude,
            y: CGFloat.greatestFiniteMagnitude
        )
    }
    var point = CGPoint.zero
    AXValueGetValue(positionValue as! AXValue, .cgPoint, &point)
    return point
}

private let digitKeyCodes: [CGKeyCode] = [
    CGKeyCode(kVK_ANSI_1),
    CGKeyCode(kVK_ANSI_2),
    CGKeyCode(kVK_ANSI_3),
    CGKeyCode(kVK_ANSI_4),
    CGKeyCode(kVK_ANSI_5),
    CGKeyCode(kVK_ANSI_6),
]

// Prefer pressing the sidebar entry, which works with Claude in the
// background. When the chat list is not exposed — collapsed sidebar, or a
// view without it — fall back to Claude's own Command-digit shortcut, which
// only reaches Claude while it is frontmost.
// Claude switches chats with Command-digit, which is the only route that
// reliably lands: the status-labelled elements in the sidebar accept an
// accessibility press and report success without navigating anywhere. The
// shortcut is delivered to Claude itself, and Claude is brought forward first
// because opening a chat means the user wants to look at it.
private func pressRecentTask(_ index: Int, in application: NSRunningApplication) {
    guard digitKeyCodes.indices.contains(index) else { return }
    // Posting to the process leaves the frontmost app alone, so switching a
    // chat never steals focus from whatever the user is doing. Claude is only
    // brought forward when the shortcut demonstrably did not land, which is how
    // a background-delivered menu shortcut fails.
    // Claude has to be frontmost to switch chats. Command-digit is a menu
    // shortcut, which a background app ignores, and the sidebar rows report a
    // successful accessibility press without navigating anywhere -- both were
    // measured against Claude 1.24012.1. Codex Micro switches threads in the
    // background only because ChatGPT listens to the keyboard itself.
    application.activate(options: [])
    sendKey(digitKeyCodes[index], flags: .maskCommand, to: application)
    lightsLog("recent task \(index + 1): sent Command-\(index + 1)")
}

// MARK: - Recent task status polling for the lights engine

private var cachedRecentTaskButtons: [AXUIElement] = []
private var lastRecentTaskScan = Date.distantPast
private let recentTaskRescanInterval: TimeInterval = 10

private func statusWords(fromCachedButtons slotCount: Int) -> (statuses: [String?], stale: Bool) {
    var statuses: [String?] = []
    var stale = false
    for index in 0..<slotCount {
        guard cachedRecentTaskButtons.indices.contains(index) else {
            statuses.append(nil)
            continue
        }
        let label = normalized(elementLabel(cachedRecentTaskButtons[index]))
        if let prefix = recentStatusPrefixes.first(where: { label.hasPrefix($0) }) {
            statuses.append(prefix.trimmingCharacters(in: .whitespaces))
        } else {
            statuses.append(nil)
            stale = true
        }
    }
    return (statuses, stale)
}

/// Returns one normalized status word per task slot ("working", "idle",
/// "unread", "awaiting approval", "awaiting response", "error"), or nil for
/// empty slots. Returns nil when Claude is not running or accessibility
/// access has not been granted. Full accessibility scans are throttled;
/// between scans only the cached buttons' labels are re-read.
func recentTaskStatuses(slotCount: Int) -> [String?]? {
    guard AXIsProcessTrusted(), let application = runningClaude() else { return nil }

    let now = Date()
    if cachedRecentTaskButtons.isEmpty
        || now.timeIntervalSince(lastRecentTaskScan) > recentTaskRescanInterval {
        cachedRecentTaskButtons = recentTaskButtons(in: application)
        lastRecentTaskScan = now
    }

    var result = statusWords(fromCachedButtons: slotCount)
    if result.stale {
        cachedRecentTaskButtons = recentTaskButtons(in: application)
        lastRecentTaskScan = now
        result = statusWords(fromCachedButtons: slotCount)
    }
    return result.statuses
}

private func effortSlider(in application: NSRunningApplication) -> AXUIElement? {
    allElements(application).first { element in
        guard stringAttribute(element, kAXRoleAttribute) == (kAXSliderRole as String) else {
            return false
        }
        return normalized(elementLabel(element)).contains("effort") ||
            normalized(stringAttribute(element, kAXDescriptionAttribute) ?? "").contains("effort")
    }
}

private func toggleFastMode(in application: NSRunningApplication) {
    if pressControl(in: application, labels: ["Fast mode", "Toggle Fast mode"]) {
        return
    }

    func updateSlider() {
        guard
            let slider = effortSlider(in: application),
            let current = attribute(slider, kAXValueAttribute) as? NSNumber
        else {
            return
        }
        let currentValue = current.doubleValue
        let target: Double
        if currentValue > 0 {
            lastNonFastEffort = currentValue
            target = 0
        } else {
            target = lastNonFastEffort
        }
        _ = AXUIElementSetAttributeValue(
            slider,
            kAXValueAttribute as CFString,
            NSNumber(value: target)
        )
    }

    if effortSlider(in: application) != nil {
        updateSlider()
        return
    }

    let opened = allElements(application).first { element in
        isPressable(element) && normalized(elementLabel(element)).hasPrefix("effort:")
    }.map(pressElement) ?? false
    if opened {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: updateSlider)
    }
}

private func handleClaudeCommand(_ command: ClaudeCommand) {
    lightsLog("hotkey received: \(command)")
    if command == .focus {
        activateClaude()
        return
    }
    guard hasAccessibilityPermission() else {
        lightsLog("no accessibility access; cannot drive Claude")
        return
    }

    openClaude(activate: false) { application in
        guard let application else { return }
        switch command {
        case .focus:
            activateClaude()
        case .recent1, .recent2, .recent3, .recent4, .recent5, .recent6:
            guard let index = [
                ClaudeCommand.recent1,
                .recent2,
                .recent3,
                .recent4,
                .recent5,
                .recent6,
            ].firstIndex(of: command) else { return }
            pressRecentTask(index, in: application)
        case .fastMode:
            toggleFastMode(in: application)
        // Claude answers its own permission prompts from the keyboard:
        // Command-Return approves, "1" rejects. Driving those beats hunting for
        // a button whose label changes with the prompt.
        case .confirm:
            sendKey(CGKeyCode(kVK_Return), flags: .maskCommand, to: application)
        case .cancel:
            sendKey(CGKeyCode(kVK_ANSI_1), to: application)
        case .fork:
            _ = pressControl(
                in: application,
                labels: ["Fork from here", "Continue in new chat"],
                preferLast: true
            )
        case .voice:
            activateVoiceControl(in: application)
        case .zoomOut:
            sendKey(CGKeyCode(kVK_ANSI_Minus), flags: .maskCommand, to: application)
        case .zoomIn:
            sendKey(CGKeyCode(kVK_ANSI_Equal), flags: .maskCommand, to: application)
        case .actualSize:
            sendKey(CGKeyCode(kVK_ANSI_0), flags: .maskCommand, to: application)
        case .newChat:
            sendKey(CGKeyCode(kVK_ANSI_N), flags: .maskCommand, to: application)
        }
    }
}

private let hotKeyHandler: EventHandlerUPP = { _, event, _ in
    guard let event else { return OSStatus(eventNotHandledErr) }
    var hotKeyID = EventHotKeyID()
    let status = GetEventParameter(
        event,
        EventParamName(kEventParamDirectObject),
        EventParamType(typeEventHotKeyID),
        nil,
        MemoryLayout<EventHotKeyID>.size,
        nil,
        &hotKeyID
    )
    guard
        status == noErr,
        hotKeyID.signature == hotKeySignature,
        let command = ClaudeCommand(rawValue: hotKeyID.id)
    else {
        return OSStatus(eventNotHandledErr)
    }

    // Dictation is push-to-talk: the voice key starts recording when held and
    // stops when let go. Every other command acts on press only.
    let isRelease = GetEventKind(event) == UInt32(kEventHotKeyReleased)
    if isRelease && command != .voice {
        return noErr
    }
    DispatchQueue.main.async {
        if isRelease {
            stopVoiceControl()
        } else {
            handleClaudeCommand(command)
        }
    }
    return noErr
}

// Diagnostic only: reports that the keyboard's private Control-Option-Command
// combos are reaching macOS even when hotkey delivery fails. Events without
// that exact modifier signature are ignored and never recorded, so ordinary
// typing is not observed.
private var combinationMonitor: Any?

private func startCombinationMonitor() {
    let signature: NSEvent.ModifierFlags = [.control, .option, .command]
    combinationMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard flags.isSuperset(of: signature) else { return }
        lightsLog("saw private combo: keyCode \(event.keyCode)")
    }
}

private var shutdownSignalSources: [DispatchSourceSignal] = []

private func installShutdownHandlers(for engine: LightsEngine) {
    for signalNumber in [SIGTERM, SIGINT] {
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler {
            engine.shutdown { exit(0) }
        }
        source.resume()
        shutdownSignalSources.append(source)
    }
}

private func dumpAccessibilityTree() {
    guard AXIsProcessTrusted() else {
        print("No accessibility access for this binary.")
        return
    }
    guard let application = runningClaude() else {
        print("Claude is not running.")
        return
    }
    for element in allElements(application) {
        let role = stringAttribute(element, kAXRoleAttribute) ?? "?"
        let label = elementLabel(element)
        guard !label.isEmpty else { continue }
        let pressable = isPressable(element) ? "pressable" : "-"
        print("\(role)\t\(pressable)\t\(label.prefix(100))")
    }
}

@main
enum ClaudeMicroFocusApp {
    static func main() {
        if CommandLine.arguments.contains("--dump-ax") {
            dumpAccessibilityTree()
            return
        }

        NSApplication.shared.setActivationPolicy(.prohibited)

        var eventTypes = [
            EventTypeSpec(
                eventClass: OSType(kEventClassKeyboard),
                eventKind: UInt32(kEventHotKeyPressed)
            ),
            EventTypeSpec(
                eventClass: OSType(kEventClassKeyboard),
                eventKind: UInt32(kEventHotKeyReleased)
            ),
        ]
        var eventHandlerReference: EventHandlerRef?
        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            hotKeyHandler,
            eventTypes.count,
            &eventTypes,
            nil,
            &eventHandlerReference
        )
        guard installStatus == noErr else {
            fputs("Unable to install the global hotkey handler (\(installStatus)).\n", stderr)
            exit(1)
        }

        for binding in hotKeyBindings {
            var reference: EventHotKeyRef?
            let id = EventHotKeyID(signature: hotKeySignature, id: binding.command.rawValue)
            let status = RegisterEventHotKey(
                binding.keyCode,
                binding.modifiers,
                id,
                GetApplicationEventTarget(),
                0,
                &reference
            )
            guard status == noErr, let reference else {
                fputs("Unable to register Claude Micro hotkey \(binding.command.rawValue) (\(status)).\n", stderr)
                exit(1)
            }
            registeredHotKeys.append(reference)
        }

        let lightsEngine = LightsEngine(statusProvider: {
            recentTaskStatuses(slotCount: lightsSlotCount)
        })
        // The keyboard's Codex-controlled Layer 1 task keys arrive as vendor
        // HID notifications; map them to the same recent-chat commands so the
        // status lights and the keys work together on Layer 1.
        let recentCommands: [ClaudeCommand] = [
            .recent1, .recent2, .recent3, .recent4, .recent5, .recent6,
        ]
        lightsEngine.onTaskKeyPressed = { slot in
            guard recentCommands.indices.contains(slot) else { return }
            handleClaudeCommand(recentCommands[slot])
        }
        lightsEngine.start()
        startCombinationMonitor()
        installShutdownHandlers(for: lightsEngine)

        NSApplication.shared.run()
    }
}
