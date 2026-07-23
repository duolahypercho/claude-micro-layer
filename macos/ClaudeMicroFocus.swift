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
    case send
}

private struct HotKeyBinding {
    let command: ClaudeCommand
    let keyCode: UInt32
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
    HotKeyBinding(command: .voice, keyCode: UInt32(kVK_ANSI_V)),
    HotKeyBinding(command: .send, keyCode: UInt32(kVK_Return)),
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

private func composerTextArea(in application: NSRunningApplication) -> AXUIElement? {
    allElements(application).first { element in
        guard
            stringAttribute(element, kAXRoleAttribute) == (kAXTextAreaRole as String),
            isEnabled(element)
        else { return false }
        var settable = DarwinBoolean(false)
        AXUIElementIsAttributeSettable(
            element,
            kAXFocusedAttribute as CFString,
            &settable
        )
        return settable.boolValue
    }
}

// Sending is a Return in the focused composer rather than a labelled button,
// so focus the message field first; this also works with Claude in the
// background, where a bare Return would go to the frontmost app instead.
private func sendMessage(in application: NSRunningApplication) {
    if let composer = composerTextArea(in: application) {
        _ = AXUIElementSetAttributeValue(
            composer,
            kAXFocusedAttribute as CFString,
            kCFBooleanTrue
        )
    }
    sendKey(CGKeyCode(kVK_Return), to: application)
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

// Claude's dictation control is a composer checkbox with no keyboard
// shortcut (verified via the accessibility tree: "Press and hold to
// record" inside the "Dictation" group), so toggle it directly.
private func activateVoiceControl(in application: NSRunningApplication) {
    if pressControl(
        in: application,
        labels: [
            "Press and hold to record",
            "Stop recording",
            "Dictation",
            "Start dictation",
            "Voice input",
        ]
    ) {
        return
    }
    _ = pressControl(in: application, labels: ["Start Dictation…"])
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
private func pressRecentTask(_ index: Int, in application: NSRunningApplication) {
    let recentTasks = recentTaskButtons(in: application)
    if recentTasks.indices.contains(index) {
        _ = pressElement(recentTasks[index])
        return
    }
    guard digitKeyCodes.indices.contains(index) else { return }
    sendKey(digitKeyCodes[index], flags: .maskCommand, to: application)
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
    if command == .focus {
        activateClaude()
        return
    }
    guard hasAccessibilityPermission() else { return }

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
        case .confirm:
            _ = pressControl(
                in: application,
                labels: ["Approve", "Confirm", "Allow", "Continue", "Yes"]
            )
        case .cancel:
            _ = pressControl(
                in: application,
                labels: ["Reject", "Cancel", "Stop", "Stop response", "Deny"]
            )
        case .fork:
            _ = pressControl(
                in: application,
                labels: ["Fork from here", "Continue in new chat"],
                preferLast: true
            )
        case .voice:
            activateVoiceControl(in: application)
        case .send:
            sendMessage(in: application)
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
    DispatchQueue.main.async {
        handleClaudeCommand(command)
    }
    return noErr
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

        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        var eventHandlerReference: EventHandlerRef?
        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            hotKeyHandler,
            1,
            &eventType,
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
                hotKeyModifiers,
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
        installShutdownHandlers(for: lightsEngine)

        NSApplication.shared.run()
    }
}
