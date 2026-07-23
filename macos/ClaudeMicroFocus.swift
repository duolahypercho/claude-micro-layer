import Cocoa
import Carbon.HIToolbox

private let claudeBundleIdentifier = "com.anthropic.claudefordesktop"
private let fallbackClaudeURL = URL(fileURLWithPath: "/Applications/Claude.app")

private func activateClaude() {
    DispatchQueue.main.async {
        if let application = NSRunningApplication.runningApplications(
            withBundleIdentifier: claudeBundleIdentifier
        ).first {
            application.unhide()
            application.activate(options: [.activateAllWindows])
            return
        }

        let workspace = NSWorkspace.shared
        let applicationURL = workspace.urlForApplication(
            withBundleIdentifier: claudeBundleIdentifier
        ) ?? fallbackClaudeURL
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        workspace.openApplication(
            at: applicationURL,
            configuration: configuration,
            completionHandler: nil
        )
    }
}

private let hotKeyHandler: EventHandlerUPP = { _, _, _ in
    activateClaude()
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

var hotKeyReference: EventHotKeyRef?
let hotKeyID = EventHotKeyID(signature: 0x434D4643, id: 1) // CMFC
let registerStatus = RegisterEventHotKey(
    UInt32(kVK_ANSI_C),
    UInt32(controlKey | optionKey | cmdKey),
    hotKeyID,
    GetApplicationEventTarget(),
    0,
    &hotKeyReference
)
guard registerStatus == noErr else {
    fputs("Unable to register Control-Option-Command-C (\(registerStatus)).\n", stderr)
    exit(1)
}

NSApplication.shared.run()
