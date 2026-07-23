import Cocoa
import IOKit.hid

// Talks the Codex Micro's vendor JSON-RPC directly over HID output reports so
// the six Claude task keys can mirror chat status. The wire format was
// confirmed against firmware v0.4.1: 64-byte reports carrying report id 6,
// a channel byte (2 = RPC), a payload length byte, and up to 61 payload bytes.
// Thread lighting is volatile device state; the configured keymap and the
// Codex-controlled Layer 1 are never written.

let lightsSlotCount = 6

enum SlotEffect: Int {
    case off = 0
    case solid = 1
    case breath = 4
}

struct LightsColors {
    var pass: Int
    var active: Int
    var error: Int
}

struct LightsConfig {
    var enabled: Bool
    var pollIntervalMs: Int
    var rpcTimeoutMs: Int
    var claudeLayerIndex: Int
    var colors: LightsColors

    static let defaults = LightsConfig(
        enabled: false,
        pollIntervalMs: 2000,
        rpcTimeoutMs: 75000,
        claudeLayerIndex: 1,
        colors: LightsColors(pass: 0x22C55E, active: 0xF59E0B, error: 0xEF4444)
    )
}

func lightsConfigURL(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
    homeDirectory
        .appendingPathComponent("Library")
        .appendingPathComponent("Application Support")
        .appendingPathComponent("ClaudeMicroLayer")
        .appendingPathComponent("lights.json")
}

private func parseColor(_ value: Any?) -> Int? {
    if let number = value as? NSNumber { return number.intValue }
    guard var text = value as? String else { return nil }
    text = text.trimmingCharacters(in: .whitespaces)
    if text.hasPrefix("#") { text.removeFirst() }
    guard text.count == 6, let color = Int(text, radix: 16) else { return nil }
    return color
}

func loadLightsConfig() -> LightsConfig {
    var config = LightsConfig.defaults
    guard
        let data = try? Data(contentsOf: lightsConfigURL()),
        let object = try? JSONSerialization.jsonObject(with: data),
        let root = object as? [String: Any]
    else { return config }

    if let enabled = root["enabled"] as? Bool { config.enabled = enabled }
    if let interval = (root["pollIntervalMs"] as? NSNumber)?.intValue {
        config.pollIntervalMs = max(500, interval)
    }
    if let timeout = (root["rpcTimeoutMs"] as? NSNumber)?.intValue {
        config.rpcTimeoutMs = min(max(2000, timeout), 120000)
    }
    if let layer = (root["claudeLayerIndex"] as? NSNumber)?.intValue {
        config.claudeLayerIndex = layer
    }
    if let colors = root["colors"] as? [String: Any] {
        if let pass = parseColor(colors["pass"]) { config.colors.pass = pass }
        if let active = parseColor(colors["active"]) { config.colors.active = active }
        if let error = parseColor(colors["error"]) { config.colors.error = error }
    }
    return config
}

struct SlotLighting: Equatable {
    let id: Int
    let color: Int
    let brightness: Double
    let effect: SlotEffect
    let speed: Double

    static func off(id: Int) -> SlotLighting {
        SlotLighting(id: id, color: 0, brightness: 0, effect: .off, speed: 0)
    }
}

func allSlotsOff() -> [SlotLighting] {
    (0..<lightsSlotCount).map(SlotLighting.off)
}

func slotLighting(forStatuses statuses: [String?], colors: LightsColors) -> [SlotLighting] {
    (0..<lightsSlotCount).map { index in
        let status = index < statuses.count ? statuses[index] : nil
        switch status {
        case "unread":
            return SlotLighting(id: index, color: colors.pass, brightness: 1, effect: .breath, speed: 0.4)
        case "running", "working", "awaiting approval", "awaiting response", "needs attention":
            return SlotLighting(id: index, color: colors.active, brightness: 1, effect: .breath, speed: 0.4)
        case "idle":
            return SlotLighting(id: index, color: colors.active, brightness: 1, effect: .solid, speed: 0)
        case "error":
            return SlotLighting(id: index, color: colors.error, brightness: 1, effect: .breath, speed: 0.4)
        default:
            return .off(id: index)
        }
    }
}

private func rpcParams(_ slots: [SlotLighting]) -> [[String: Any]] {
    slots.map { slot in
        [
            "id": slot.id,
            "c": slot.color,
            "b": slot.brightness,
            "e": slot.effect.rawValue,
            "s": slot.speed,
        ]
    }
}

private func slotKey(_ slots: [SlotLighting]) -> String {
    slots
        .map { "\($0.id):\($0.color):\($0.brightness):\($0.effect.rawValue):\($0.speed)" }
        .joined(separator: "|")
}

func ensureInputMonitoringAccess() -> Bool {
    if IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted {
        return true
    }
    IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
    return false
}

// Deduplicated stderr logging so the launchd log stays readable while the
// engine polls every couple of seconds.
private var lastLightsLogMessage = ""

func lightsLog(_ message: String) {
    guard message != lastLightsLogMessage else { return }
    lastLightsLogMessage = message
    let timestamp = ISO8601DateFormatter().string(from: Date())
    fputs("[\(timestamp)] lights: \(message)\n", stderr)
}

// MARK: - HID JSON-RPC client

final class MicroHIDClient {
    static let vendorId = 12346
    static let productId = 33632
    static let vendorUsagePage = 0xFF00
    static let reportId: UInt8 = 6
    static let rpcChannel: UInt8 = 2
    static let maxChunkSize = 61

    // The sleeping keyboard flushes its Bluetooth LE queue roughly once per
    // minute, so a response can lag the request by up to a minute. A timeout
    // shorter than that wake cycle discards every reply as stale and the
    // exchange never converges; keep one request pending across a full wake
    // cycle instead. Configurable via lights.json.
    var rpcTimeout: TimeInterval = 75

    private let manager: IOHIDManager
    private var device: IOHIDDevice?
    private var inputReportBuffer: UnsafeMutablePointer<UInt8>?
    private var inputReportBufferSize = 0
    private var rpcText = ""
    private var pendingId: Int?
    private var pendingMethod: String?
    private var pendingCompletion: (([String: Any]?) -> Void)?
    private var pendingTimeout: DispatchWorkItem?
    private var nextRpcId = 1
    private var receivedReportCount = 0
    private var lastReportPrefix = "none"

    /// Called with the key code ("AG00"..."AG05") when the keyboard's Layer 1
    /// task keys emit a vendor HID notification.
    var onTaskKeyEvent: ((String) -> Void)?

    var isDeviceAttached: Bool { device != nil }

    init() {
        manager = IOHIDManagerCreate(kCFAllocatorDefault, IOHIDOptionsType(kIOHIDOptionsTypeNone))
        // Match on vendor and product only. Over Bluetooth the keyboard is one
        // IOHIDDevice whose primary usage pair is the keyboard collection, so
        // matching on the vendor usage page would find nothing; the vendor
        // collection is reached through report id 6 on the same device.
        let matching: [String: Any] = [
            kIOHIDVendorIDKey: Self.vendorId,
            kIOHIDProductIDKey: Self.productId,
        ]
        IOHIDManagerSetDeviceMatching(manager, matching as CFDictionary)
        let context = Unmanaged.passUnretained(self).toOpaque()
        IOHIDManagerRegisterDeviceMatchingCallback(
            manager,
            { context, _, _, device in
                guard let context else { return }
                Unmanaged<MicroHIDClient>.fromOpaque(context)
                    .takeUnretainedValue()
                    .attach(device)
            },
            context
        )
        IOHIDManagerRegisterDeviceRemovalCallback(
            manager,
            { context, _, _, device in
                guard let context else { return }
                Unmanaged<MicroHIDClient>.fromOpaque(context)
                    .takeUnretainedValue()
                    .detach(device)
            },
            context
        )
        IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue)
        let openStatus = IOHIDManagerOpen(manager, IOHIDOptionsType(kIOHIDOptionsTypeNone))
        if openStatus != kIOReturnSuccess {
            lightsLog("IOHIDManagerOpen failed (\(String(format: "0x%08X", openStatus))); check Input Monitoring access")
        }
    }

    private func attach(_ device: IOHIDDevice) {
        guard self.device == nil else { return }
        self.device = device

        let openStatus = IOHIDDeviceOpen(device, IOHIDOptionsType(kIOHIDOptionsTypeNone))
        if openStatus != kIOReturnSuccess {
            lightsLog("IOHIDDeviceOpen failed (\(String(format: "0x%08X", openStatus)))")
        }

        // The input callback silently stops delivering when the buffer is
        // smaller than the device's largest input report, so size it from the
        // device property instead of assuming the 64-byte vendor report.
        let maxReportSize = max(
            64,
            (IOHIDDeviceGetProperty(device, kIOHIDMaxInputReportSizeKey as CFString) as? NSNumber)?
                .intValue ?? 64
        )
        inputReportBuffer?.deallocate()
        inputReportBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: maxReportSize)
        inputReportBufferSize = maxReportSize
        lightsLog("Codex Micro attached (max input report \(maxReportSize) bytes)")

        let context = Unmanaged.passUnretained(self).toOpaque()
        IOHIDDeviceRegisterInputReportCallback(
            device,
            inputReportBuffer!,
            maxReportSize,
            { context, _, _, _, _, report, reportLength in
                guard let context else { return }
                Unmanaged<MicroHIDClient>.fromOpaque(context)
                    .takeUnretainedValue()
                    .handleReport(bytes: report, count: Int(reportLength))
            },
            context
        )
    }

    private func detach(_ device: IOHIDDevice) {
        guard self.device === device else { return }
        self.device = nil
        rpcText = ""
        lightsLog("Codex Micro detached")
        finishPending(with: nil)
    }

    // Some HID stacks deliver the report id as the first byte and some strip
    // it, so detect the leading id byte instead of assuming either shape.
    private func handleReport(bytes: UnsafeMutablePointer<UInt8>, count: Int) {
        receivedReportCount += 1
        lastReportPrefix = (0..<min(count, 4))
            .map { String(format: "%02X", bytes[$0]) }
            .joined(separator: " ")
        guard count >= 3 else { return }
        let headerIndex = bytes[0] == Self.reportId ? 1 : 0
        guard headerIndex + 2 <= count else { return }
        guard bytes[headerIndex] == Self.rpcChannel else { return }
        let payloadLength = Int(bytes[headerIndex + 1])
        let start = headerIndex + 2
        let end = min(start + payloadLength, count)
        guard end > start else { return }
        let data = Data(bytes: bytes + start, count: end - start)
        guard let text = String(data: data, encoding: .utf8) else { return }

        rpcText += text
        while let newline = rpcText.rangeOfCharacter(from: .newlines) {
            let line = String(rpcText[..<newline.lowerBound])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            rpcText.removeSubrange(..<newline.upperBound)
            if !line.isEmpty { handleLine(line) }
        }
    }

    // The sleeping keyboard often processes a queued request during one wake
    // cycle but delivers the reply in the next, so the reply's id belongs to
    // an earlier retry of the same call. The engine only ever retries one
    // idempotent request at a time, so match replies by method and treat the
    // id as informational.
    private func handleLine(_ line: String) {
        guard
            let data = line.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data),
            let root = object as? [String: Any]
        else { return }

        // Device-initiated notifications carry a method but no id.
        let notificationMethod = (root["method"] as? String) ?? (root["m"] as? String)
        if notificationMethod == "v.oai.hid", root["id"] == nil, root["i"] == nil {
            let params = root["params"] as? [String: Any]
            if let key = params?["k"] as? String {
                onTaskKeyEvent?(key)
            }
            return
        }

        guard let pendingMethod, pendingCompletion != nil else { return }
        let responseMethod = notificationMethod
        if let responseMethod {
            guard responseMethod == pendingMethod else { return }
        } else {
            let responseId = (root["id"] as? NSNumber)?.intValue
                ?? (root["i"] as? NSNumber)?.intValue
            guard responseId == pendingId else { return }
        }
        finishPending(with: root)
    }

    private func finishPending(with response: [String: Any]?) {
        pendingTimeout?.cancel()
        pendingTimeout = nil
        pendingId = nil
        pendingMethod = nil
        let completion = pendingCompletion
        pendingCompletion = nil
        completion?(response)
    }

    /// Sends one JSON-RPC request. Only one request may be in flight; the
    /// completion receives nil on timeout, write failure, or disconnect.
    func call(method: String, params: Any?, completion: @escaping ([String: Any]?) -> Void) {
        guard pendingCompletion == nil, let device else {
            completion(nil)
            return
        }
        let requestId = nextRpcId
        nextRpcId = nextRpcId % 998 + 1
        let request: [String: Any] = [
            "method": method,
            "params": params ?? NSNull(),
            "id": requestId,
        ]
        guard let payload = try? JSONSerialization.data(withJSONObject: request) else {
            completion(nil)
            return
        }

        // Never clear rpcText here: a reply can straddle a timeout/retry
        // boundary, and discarding its first fragments would leave only
        // unparseable tails. The newline-delimited stream self-synchronizes.
        pendingId = requestId
        pendingMethod = method
        pendingCompletion = completion
        let reportCountAtSend = receivedReportCount
        let timeoutWork = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let received = self.receivedReportCount - reportCountAtSend
            lightsLog("rpc \(method) timed out; \(received) input reports since send, last [\(self.lastReportPrefix)]")
            self.finishPending(with: nil)
        }
        pendingTimeout = timeoutWork
        DispatchQueue.main.asyncAfter(deadline: .now() + rpcTimeout, execute: timeoutWork)

        let bytes = [UInt8](payload)
        var offset = 0
        while offset < bytes.count {
            let size = min(Self.maxChunkSize, bytes.count - offset)
            var report = [UInt8](repeating: 0, count: 63)
            report[0] = Self.rpcChannel
            report[1] = UInt8(size)
            for index in 0..<size { report[2 + index] = bytes[offset + index] }
            let status = report.withUnsafeBufferPointer { pointer in
                IOHIDDeviceSetReport(
                    device,
                    kIOHIDReportTypeOutput,
                    CFIndex(Self.reportId),
                    pointer.baseAddress!,
                    report.count
                )
            }
            guard status == kIOReturnSuccess else {
                lightsLog("IOHIDDeviceSetReport failed (\(String(format: "0x%08X", status)))")
                finishPending(with: nil)
                return
            }
            offset += size
        }
    }
}

// MARK: - Lighting engine

final class LightsEngine {
    private let statusProvider: () -> [String?]?
    private var client: MicroHIDClient?
    private var timer: Timer?
    private var scheduledIntervalMs = 0
    private var lastAppliedKey: String?
    private var requestInFlight = false
    private var lastLayerCheck = Date.distantPast
    private static let layerRecheckInterval: TimeInterval = 15
    private var lastTaskKeyEvent = Date.distantPast

    /// Called with the slot index (0-5) when a Layer 1 task key is pressed on
    /// the keyboard. Events are debounced because the device can report both
    /// press and release.
    var onTaskKeyPressed: ((Int) -> Void)?

    /// statusProvider returns one normalized status word per task slot, or nil
    /// when Claude is not running or accessibility access is unavailable.
    init(statusProvider: @escaping () -> [String?]?) {
        self.statusProvider = statusProvider
    }

    func start() {
        reschedule(intervalMs: LightsConfig.defaults.pollIntervalMs)
    }

    func shutdown(completion: @escaping () -> Void) {
        timer?.invalidate()
        timer = nil
        guard let client, client.isDeviceAttached, lastAppliedKey != nil else {
            completion()
            return
        }
        client.call(method: "v.oai.thstatus", params: shutdownParams()) { _ in completion() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: completion)
    }

    private func shutdownParams() -> [[String: Any]] {
        allSlotsOff().map { ["id": $0.id, "c": 0, "b": 0, "e": 0, "s": 0] }
    }

    private func reschedule(intervalMs: Int) {
        guard intervalMs != scheduledIntervalMs else { return }
        scheduledIntervalMs = intervalMs
        timer?.invalidate()
        let timer = Timer(timeInterval: Double(intervalMs) / 1000, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func tick() {
        let config = loadLightsConfig()
        reschedule(intervalMs: config.pollIntervalMs)
        guard config.enabled else {
            clearIfNeeded()
            return
        }
        // Open the HID manager even before access is granted so the helper
        // appears in the Input Monitoring list for the user to enable.
        if client == nil {
            let client = MicroHIDClient()
            client.onTaskKeyEvent = { [weak self] key in
                guard let self else { return }
                guard
                    key.count == 4,
                    key.hasPrefix("AG0"),
                    let slot = Int(key.suffix(1)),
                    (0..<lightsSlotCount).contains(slot)
                else { return }
                let now = Date()
                guard now.timeIntervalSince(self.lastTaskKeyEvent) > 0.3 else { return }
                self.lastTaskKeyEvent = now
                self.onTaskKeyPressed?(slot)
            }
            self.client = client
        }
        client?.rpcTimeout = Double(config.rpcTimeoutMs) / 1000
        guard ensureInputMonitoringAccess() else {
            lightsLog("waiting for Input Monitoring access; enable claude-micro-focus in System Settings, then restart the helper")
            return
        }
        guard let client, client.isDeviceAttached else {
            lightsLog("waiting for the Codex Micro to attach")
            lastAppliedKey = nil
            return
        }
        guard !requestInFlight else { return }
        requestInFlight = true

        let statuses = statusProvider()
        let desired: [SlotLighting]
        if let statuses {
            desired = slotLighting(forStatuses: statuses, colors: config.colors)
        } else {
            lightsLog("Claude not running or accessibility access missing; keeping lights off")
            desired = allSlotsOff()
        }

        // When the lighting is already correct, avoid re-polling the layer on
        // every tick; a sleepy Bluetooth link makes each RPC expensive.
        if slotKey(desired) == lastAppliedKey,
            Date().timeIntervalSince(lastLayerCheck) < Self.layerRecheckInterval {
            requestInFlight = false
            return
        }

        guard config.claudeLayerIndex >= 0 else {
            apply(desired, using: client)
            return
        }
        client.call(method: "device.status", params: nil) { [weak self] response in
            guard let self else { return }
            guard
                let result = response?["result"] as? [String: Any],
                let layer = (result["layer_index"] as? NSNumber)?.intValue
            else {
                lightsLog("device.status RPC failed; will retry")
                self.requestInFlight = false
                return
            }
            self.lastLayerCheck = Date()
            if layer != config.claudeLayerIndex {
                lightsLog("layer \(layer + 1) active; Claude lights pause until layer \(config.claudeLayerIndex + 1) is selected")
            }
            let slots = layer == config.claudeLayerIndex ? desired : allSlotsOff()
            self.apply(slots, using: client)
        }
    }

    private func apply(_ slots: [SlotLighting], using client: MicroHIDClient) {
        let key = slotKey(slots)
        guard key != lastAppliedKey else {
            requestInFlight = false
            return
        }
        client.call(method: "v.oai.thstatus", params: rpcParams(slots)) { [weak self] response in
            guard let self else { return }
            if response?["result"] != nil {
                self.lastAppliedKey = key
                lightsLog("applied slots [\(key)]")
            } else if let response,
                let data = try? JSONSerialization.data(withJSONObject: response),
                let text = String(data: data, encoding: .utf8) {
                lightsLog("thstatus rejected: \(text.prefix(160))")
            } else {
                lightsLog("thstatus RPC failed; will retry")
            }
            self.requestInFlight = false
        }
    }

    private func clearIfNeeded() {
        guard
            let client,
            client.isDeviceAttached,
            lastAppliedKey != nil,
            lastAppliedKey != slotKey(allSlotsOff()),
            !requestInFlight
        else { return }
        requestInFlight = true
        apply(allSlotsOff(), using: client)
    }
}
