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

private func runningClaude() -> NSRunningApplication? {
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

private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
        return nil
    }
    return value
}

private func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
    attribute(element, name) as? String
}

private func elementLabel(_ element: AXUIElement) -> String {
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

private func children(_ element: AXUIElement) -> [AXUIElement] {
    attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

private func isEnabled(_ element: AXUIElement) -> Bool {
    (attribute(element, kAXEnabledAttribute) as? Bool) ?? true
}

private func isPressable(_ element: AXUIElement) -> Bool {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else {
        return false
    }
    return (names as? [String])?.contains(kAXPressAction as String) ?? false
}

private func allElements(_ application: NSRunningApplication) -> [AXUIElement] {
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

private func normalized(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

private func pressElement(_ element: AXUIElement) -> Bool {
    isEnabled(element) &&
        AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
}

private func pressControl(
    in application: NSRunningApplication,
    labels: [String],
    preferLast: Bool = false
) -> Bool {
    let wanted = labels.map(normalized)
    let matches = allElements(application).filter { element in
        guard isPressable(element), isEnabled(element) else { return false }
        let label = normalized(elementLabel(element))
        return wanted.contains(label) || wanted.contains { label.hasPrefix("\($0) ") }
    }
    guard let target = preferLast ? matches.last : matches.first else {
        return false
    }
    return pressElement(target)
}

private func sendKey(_ keyCode: CGKeyCode, to application: NSRunningApplication) {
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
    keyDown.postToPid(application.processIdentifier)
    keyUp.postToPid(application.processIdentifier)
}

private func activateVoiceControl(in application: NSRunningApplication) {
    if pressControl(
        in: application,
        labels: ["Dictation", "Start dictation", "Voice input", "Start voice mode"]
    ) {
        return
    }

    let wanted = ["dictation", "start dictation", "voice input", "start voice mode"]
    guard let target = allElements(application).first(where: { element in
        isEnabled(element) && wanted.contains(normalized(elementLabel(element)))
    }) else {
        return
    }
    guard AXUIElementSetAttributeValue(
        target,
        kAXFocusedAttribute as CFString,
        kCFBooleanTrue
    ) == .success else {
        return
    }
    sendKey(CGKeyCode(kVK_Return), to: application)
}

private let recentStatusPrefixes = [
    "working ",
    "unread ",
    "idle ",
    "awaiting approval ",
    "awaiting response ",
    "error ",
]

private func pressRecentTask(_ index: Int, in application: NSRunningApplication) {
    let recentTasks = allElements(application).filter { element in
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
    guard recentTasks.indices.contains(index) else { return }
    _ = pressElement(recentTasks[index])
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
            _ = pressControl(in: application, labels: ["Send"])
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

NSApplication.shared.run()
