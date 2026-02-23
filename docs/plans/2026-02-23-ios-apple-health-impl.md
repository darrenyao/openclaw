# iOS Apple Health Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add HealthKit integration to the iOS Node so Agent can query health data (steps, heart rate, sleep) and receive real-time updates.

**Architecture:** Follow the existing Motion capability pattern — shared command types in OpenClawKit, service implementation in iOS app, capability registration in GatewayConnectionController, command policy in Gateway TypeScript. Real-time push via existing `node.event` WebSocket mechanism with `HKObserverQuery`.

**Tech Stack:** Swift 6.0 / HealthKit framework / OpenClawKit SPM package / TypeScript (Gateway)

**Design doc:** `docs/plans/2026-02-23-ios-apple-health-design.md`

---

### Task 1: Add HealthCommands.swift to OpenClawKit (shared types)

**Files:**

- Create: `apps/shared/OpenClawKit/Sources/OpenClawKit/HealthCommands.swift`

**Reference:** `apps/shared/OpenClawKit/Sources/OpenClawKit/MotionCommands.swift` — follow exact same patterns (public, Codable, Sendable, Equatable, explicit inits).

**Step 1: Create HealthCommands.swift**

```swift
import Foundation

// MARK: - Command Enum

public enum OpenClawHealthCommand: String, Codable, Sendable {
    case query = "health.query"
    case summary = "health.summary"
    case subscribe = "health.subscribe"
    case unsubscribe = "health.unsubscribe"
}

// MARK: - Data Type Enum

public enum OpenClawHealthDataType: String, Codable, Sendable {
    case stepCount
    case heartRate
    case sleepAnalysis
}

// MARK: - health.query

public struct OpenClawHealthQueryParams: Codable, Sendable, Equatable {
    public var type: String
    public var startISO: String?
    public var endISO: String?
    public var limit: Int?
    public var ascending: Bool?

    public init(
        type: String,
        startISO: String? = nil,
        endISO: String? = nil,
        limit: Int? = nil,
        ascending: Bool? = nil)
    {
        self.type = type
        self.startISO = startISO
        self.endISO = endISO
        self.limit = limit
        self.ascending = ascending
    }
}

public struct OpenClawHealthSample: Codable, Sendable, Equatable {
    public var dateISO: String
    public var endDateISO: String?
    public var value: Double?
    public var unit: String?
    public var category: String?
    public var source: String?

    public init(
        dateISO: String,
        endDateISO: String? = nil,
        value: Double? = nil,
        unit: String? = nil,
        category: String? = nil,
        source: String? = nil)
    {
        self.dateISO = dateISO
        self.endDateISO = endDateISO
        self.value = value
        self.unit = unit
        self.category = category
        self.source = source
    }
}

public struct OpenClawHealthQueryPayload: Codable, Sendable, Equatable {
    public var type: String
    public var startISO: String
    public var endISO: String
    public var samples: [OpenClawHealthSample]

    public init(type: String, startISO: String, endISO: String, samples: [OpenClawHealthSample]) {
        self.type = type
        self.startISO = startISO
        self.endISO = endISO
        self.samples = samples
    }
}

// MARK: - health.summary

public struct OpenClawHealthSummaryParams: Codable, Sendable, Equatable {
    public var type: String
    public var startISO: String?
    public var endISO: String?
    public var interval: String?

    public init(
        type: String,
        startISO: String? = nil,
        endISO: String? = nil,
        interval: String? = nil)
    {
        self.type = type
        self.startISO = startISO
        self.endISO = endISO
        self.interval = interval
    }
}

public struct OpenClawHealthStatistic: Codable, Sendable, Equatable {
    public var startISO: String
    public var endISO: String
    public var sum: Double?
    public var average: Double?
    public var min: Double?
    public var max: Double?
    public var unit: String

    public init(
        startISO: String,
        endISO: String,
        sum: Double? = nil,
        average: Double? = nil,
        min: Double? = nil,
        max: Double? = nil,
        unit: String)
    {
        self.startISO = startISO
        self.endISO = endISO
        self.sum = sum
        self.average = average
        self.min = min
        self.max = max
        self.unit = unit
    }
}

public struct OpenClawHealthSummaryPayload: Codable, Sendable, Equatable {
    public var type: String
    public var interval: String
    public var statistics: [OpenClawHealthStatistic]

    public init(type: String, interval: String, statistics: [OpenClawHealthStatistic]) {
        self.type = type
        self.interval = interval
        self.statistics = statistics
    }
}

// MARK: - health.subscribe / unsubscribe

public struct OpenClawHealthSubscribeParams: Codable, Sendable, Equatable {
    public var types: [String]

    public init(types: [String]) {
        self.types = types
    }
}

// MARK: - health.update event payload (Node -> Gateway push)

public struct OpenClawHealthUpdatePayload: Codable, Sendable, Equatable {
    public var type: String
    public var latestSamples: [OpenClawHealthSample]

    public init(type: String, latestSamples: [OpenClawHealthSample]) {
        self.type = type
        self.latestSamples = latestSamples
    }
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/yixuan.yhl/developers/openclaw/apps/shared/OpenClawKit && swift build 2>&1 | tail -5`

Expected: Build Succeeded (no HealthKit import needed here — pure data types)

**Step 3: Commit**

```bash
git add apps/shared/OpenClawKit/Sources/OpenClawKit/HealthCommands.swift
git commit -m "feat(health): add HealthKit command types to OpenClawKit"
```

---

### Task 2: Add `health` capability to OpenClawCapability enum

**Files:**

- Modify: `apps/shared/OpenClawKit/Sources/OpenClawKit/Capabilities.swift:15` — add `case health` after `case motion`

**Step 1: Add the case**

In `Capabilities.swift`, after line 15 (`case motion`), add:

```swift
    case health
```

**Step 2: Verify it compiles**

Run: `cd /Users/yixuan.yhl/developers/openclaw/apps/shared/OpenClawKit && swift build 2>&1 | tail -5`

Expected: Build Succeeded

**Step 3: Commit**

```bash
git add apps/shared/OpenClawKit/Sources/OpenClawKit/Capabilities.swift
git commit -m "feat(health): add health capability enum case"
```

---

### Task 3: Add HealthKitServicing protocol

**Files:**

- Modify: `apps/ios/Sources/Services/NodeServiceProtocols.swift:66` — add `HealthKitServicing` protocol after `MotionServicing`

**Step 1: Add the protocol**

After line 66 (closing `}` of `MotionServicing`), add:

```swift

protocol HealthKitServicing: Sendable {
    func query(params: OpenClawHealthQueryParams) async throws -> OpenClawHealthQueryPayload
    func summary(params: OpenClawHealthSummaryParams) async throws -> OpenClawHealthSummaryPayload
    func subscribe(
        types: [OpenClawHealthDataType],
        onUpdate: @escaping @Sendable (OpenClawHealthUpdatePayload) -> Void) async throws
    func unsubscribe(types: [OpenClawHealthDataType]) async
}
```

**Step 2: Commit**

```bash
git add apps/ios/Sources/Services/NodeServiceProtocols.swift
git commit -m "feat(health): add HealthKitServicing protocol"
```

---

### Task 4: Implement HealthService (query + summary)

**Files:**

- Create: `apps/ios/Sources/Health/HealthService.swift`

**Reference:** `apps/ios/Sources/Motion/MotionService.swift` — follow same patterns: availability checks, auth checks, `resolveRange` helper, ISO8601 formatting.

**Step 1: Create HealthService.swift**

```swift
import Foundation
import HealthKit
import OpenClawKit

final class HealthService: HealthKitServicing {
    private let store = HKHealthStore()
    private var observerQueries: [HKObjectType: HKObserverQuery] = [:]

    // MARK: - Authorization

    private func ensureAuthorization(for dataTypes: [OpenClawHealthDataType]) async throws {
        let readTypes: Set<HKObjectType> = Set(dataTypes.compactMap { $0.hkObjectType })
        guard !readTypes.isEmpty else { return }
        try await store.requestAuthorization(toShare: [], read: readTypes)
    }

    // MARK: - health.query

    func query(params: OpenClawHealthQueryParams) async throws -> OpenClawHealthQueryPayload {
        guard HKHealthStore.isHealthDataAvailable() else {
            throw Self.error(code: 1, message: "HEALTH_UNAVAILABLE: HealthKit not available on this device")
        }
        guard let dataType = OpenClawHealthDataType(rawValue: params.type) else {
            throw Self.error(code: 2, message: "HEALTH_INVALID_TYPE: unknown data type '\(params.type)'")
        }
        guard let sampleType = dataType.hkSampleType else {
            throw Self.error(code: 2, message: "HEALTH_INVALID_TYPE: '\(params.type)' is not a sample type")
        }

        try await ensureAuthorization(for: [dataType])

        let (start, end) = Self.resolveRange(startISO: params.startISO, endISO: params.endISO)
        let limit = max(1, min(params.limit ?? 100, 500))
        let ascending = params.ascending ?? false

        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        let sortDescriptor = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: ascending)

        let samples: [HKSample] = try await withCheckedThrowingContinuation { cont in
            let query = HKSampleQuery(
                sampleType: sampleType,
                predicate: predicate,
                limit: limit,
                sortDescriptors: [sortDescriptor])
            { _, results, error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume(returning: results ?? [])
                }
            }
            store.execute(query)
        }

        let formatter = ISO8601DateFormatter()
        let mapped = samples.map { sample in
            Self.mapSample(sample, dataType: dataType, formatter: formatter)
        }

        return OpenClawHealthQueryPayload(
            type: params.type,
            startISO: formatter.string(from: start),
            endISO: formatter.string(from: end),
            samples: mapped)
    }

    // MARK: - health.summary

    func summary(params: OpenClawHealthSummaryParams) async throws -> OpenClawHealthSummaryPayload {
        guard HKHealthStore.isHealthDataAvailable() else {
            throw Self.error(code: 1, message: "HEALTH_UNAVAILABLE: HealthKit not available on this device")
        }
        guard let dataType = OpenClawHealthDataType(rawValue: params.type) else {
            throw Self.error(code: 2, message: "HEALTH_INVALID_TYPE: unknown data type '\(params.type)'")
        }
        guard let quantityType = dataType.hkQuantityType else {
            throw Self.error(code: 3, message: "HEALTH_NO_SUMMARY: '\(params.type)' does not support summary (use query)")
        }

        try await ensureAuthorization(for: [dataType])

        let (start, end) = Self.resolveRange(startISO: params.startISO, endISO: params.endISO)
        let intervalStr = params.interval ?? "day"
        let interval = Self.resolveInterval(intervalStr)
        let unit = dataType.hkUnit ?? .count()

        let options: HKStatisticsOptions = dataType == .stepCount
            ? [.cumulativeSum]
            : [.discreteAverage, .discreteMin, .discreteMax]

        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)

        let statistics: [HKStatistics] = try await withCheckedThrowingContinuation { cont in
            let query = HKStatisticsCollectionQuery(
                quantityType: quantityType,
                quantitySamplePredicate: predicate,
                options: options,
                anchorDate: Calendar.current.startOfDay(for: start),
                intervalComponents: interval)

            query.initialResultsHandler = { _, collection, error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    var results: [HKStatistics] = []
                    collection?.enumerateStatistics(from: start, to: end) { stat, _ in
                        results.append(stat)
                    }
                    cont.resume(returning: results)
                }
            }
            store.execute(query)
        }

        let formatter = ISO8601DateFormatter()
        let mapped = statistics.map { stat -> OpenClawHealthStatistic in
            OpenClawHealthStatistic(
                startISO: formatter.string(from: stat.startDate),
                endISO: formatter.string(from: stat.endDate),
                sum: stat.sumQuantity()?.doubleValue(for: unit),
                average: stat.averageQuantity()?.doubleValue(for: unit),
                min: stat.minimumQuantity()?.doubleValue(for: unit),
                max: stat.maximumQuantity()?.doubleValue(for: unit),
                unit: dataType.unitString)
        }

        return OpenClawHealthSummaryPayload(
            type: params.type,
            interval: intervalStr,
            statistics: mapped)
    }

    // MARK: - health.subscribe

    func subscribe(
        types: [OpenClawHealthDataType],
        onUpdate: @escaping @Sendable (OpenClawHealthUpdatePayload) -> Void) async throws
    {
        guard HKHealthStore.isHealthDataAvailable() else {
            throw Self.error(code: 1, message: "HEALTH_UNAVAILABLE: HealthKit not available on this device")
        }

        try await ensureAuthorization(for: types)

        for dataType in types {
            guard let sampleType = dataType.hkSampleType,
                  let objectType = dataType.hkObjectType else { continue }

            // Skip if already subscribed
            if observerQueries[objectType] != nil { continue }

            let query = HKObserverQuery(sampleType: sampleType) { [weak self] _, completionHandler, error in
                guard error == nil, let self else {
                    completionHandler()
                    return
                }

                // Fetch latest samples when notified
                Task {
                    let params = OpenClawHealthQueryParams(
                        type: dataType.rawValue,
                        limit: 5,
                        ascending: false)
                    if let payload = try? await self.query(params: params) {
                        let update = OpenClawHealthUpdatePayload(
                            type: dataType.rawValue,
                            latestSamples: payload.samples)
                        onUpdate(update)
                    }
                    completionHandler()
                }
            }

            store.execute(query)
            observerQueries[objectType] = query

            store.enableBackgroundDelivery(for: objectType, frequency: .immediate) { _, error in
                if let error {
                    print("HealthService: background delivery failed for \(dataType.rawValue): \(error)")
                }
            }
        }
    }

    // MARK: - health.unsubscribe

    func unsubscribe(types: [OpenClawHealthDataType]) async {
        for dataType in types {
            guard let objectType = dataType.hkObjectType,
                  let query = observerQueries[objectType] else { continue }
            store.stop(query)
            observerQueries.removeValue(forKey: objectType)
            store.disableBackgroundDelivery(for: objectType) { _, _ in }
        }
    }

    // MARK: - Helpers

    private static func resolveRange(startISO: String?, endISO: String?) -> (Date, Date) {
        let formatter = ISO8601DateFormatter()
        let start = startISO.flatMap { formatter.date(from: $0) } ?? Calendar.current.startOfDay(for: Date())
        let end = endISO.flatMap { formatter.date(from: $0) } ?? Date()
        return (start, end)
    }

    private static func resolveInterval(_ interval: String) -> DateComponents {
        switch interval {
        case "hour": DateComponents(hour: 1)
        case "week": DateComponents(day: 7)
        default: DateComponents(day: 1)
        }
    }

    private static func mapSample(
        _ sample: HKSample,
        dataType: OpenClawHealthDataType,
        formatter: ISO8601DateFormatter) -> OpenClawHealthSample
    {
        let sourceName = sample.sourceRevision.source.name

        if let quantitySample = sample as? HKQuantitySample,
           let unit = dataType.hkUnit
        {
            return OpenClawHealthSample(
                dateISO: formatter.string(from: sample.startDate),
                endDateISO: formatter.string(from: sample.endDate),
                value: quantitySample.quantity.doubleValue(for: unit),
                unit: dataType.unitString,
                source: sourceName)
        }

        if let categorySample = sample as? HKCategorySample,
           dataType == .sleepAnalysis
        {
            let category = Self.sleepCategory(categorySample.value)
            return OpenClawHealthSample(
                dateISO: formatter.string(from: sample.startDate),
                endDateISO: formatter.string(from: sample.endDate),
                category: category,
                source: sourceName)
        }

        return OpenClawHealthSample(
            dateISO: formatter.string(from: sample.startDate),
            endDateISO: formatter.string(from: sample.endDate),
            source: sourceName)
    }

    private static func sleepCategory(_ value: Int) -> String {
        switch HKCategoryValueSleepAnalysis(rawValue: value) {
        case .inBed: "inBed"
        case .asleepUnspecified: "asleep"
        case .awake: "awake"
        case .asleepCore: "core"
        case .asleepDeep: "deep"
        case .asleepREM: "rem"
        default: "unknown"
        }
    }

    private static func error(code: Int, message: String) -> NSError {
        NSError(domain: "Health", code: code, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

// MARK: - OpenClawHealthDataType HealthKit extensions

extension OpenClawHealthDataType {
    var hkObjectType: HKObjectType? {
        switch self {
        case .stepCount: HKQuantityType(.stepCount)
        case .heartRate: HKQuantityType(.heartRate)
        case .sleepAnalysis: HKCategoryType(.sleepAnalysis)
        }
    }

    var hkSampleType: HKSampleType? {
        switch self {
        case .stepCount: HKQuantityType(.stepCount)
        case .heartRate: HKQuantityType(.heartRate)
        case .sleepAnalysis: HKCategoryType(.sleepAnalysis)
        }
    }

    var hkQuantityType: HKQuantityType? {
        switch self {
        case .stepCount: HKQuantityType(.stepCount)
        case .heartRate: HKQuantityType(.heartRate)
        case .sleepAnalysis: nil
        }
    }

    var hkUnit: HKUnit? {
        switch self {
        case .stepCount: .count()
        case .heartRate: HKUnit.count().unitDivided(by: .minute())
        case .sleepAnalysis: nil
        }
    }

    var unitString: String {
        switch self {
        case .stepCount: "count"
        case .heartRate: "bpm"
        case .sleepAnalysis: ""
        }
    }
}
```

**Step 2: Commit**

```bash
git add apps/ios/Sources/Health/HealthService.swift
git commit -m "feat(health): implement HealthService with query, summary, subscribe"
```

---

### Task 5: Integrate into NodeAppModel

**Files:**

- Modify: `apps/ios/Sources/Model/NodeAppModel.swift`
  - Add `healthService` property (near line 98, after `motionService`)
  - Add initializer parameter (near line 142, after `motionService`)
  - Add `handleHealthInvoke` method (after `handleMotionInvoke` around line 1426)
  - Register health commands in `buildCapabilityRouter()` (after motion block, around line 1577)

**Step 1: Add property and init parameter**

Near line 98, after `private let motionService: any MotionServicing`, add:

```swift
    private let healthService: any HealthKitServicing
```

Near line 142, after `motionService: any MotionServicing = MotionService(),`, add:

```swift
        healthService: any HealthKitServicing = HealthService(),
```

In the init body, after `self.motionService = motionService` (around line 156), add:

```swift
        self.healthService = healthService
```

**Step 2: Add handleHealthInvoke method**

After `handleMotionInvoke` (around line 1426), add:

```swift
    private func handleHealthInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawHealthCommand.query.rawValue:
            let params = try Self.decodeParams(OpenClawHealthQueryParams.self, from: req.paramsJSON)
            let payload = try await self.healthService.query(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)

        case OpenClawHealthCommand.summary.rawValue:
            let params = try Self.decodeParams(OpenClawHealthSummaryParams.self, from: req.paramsJSON)
            let payload = try await self.healthService.summary(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)

        case OpenClawHealthCommand.subscribe.rawValue:
            let params = try Self.decodeParams(OpenClawHealthSubscribeParams.self, from: req.paramsJSON)
            let types = params.types.compactMap { OpenClawHealthDataType(rawValue: $0) }
            try await self.healthService.subscribe(types: types) { [weak self] update in
                guard let self else { return }
                Task {
                    if let json = try? Self.encodePayload(update),
                       let jsonString = String(data: json, encoding: .utf8) {
                        await self.nodeGateway.sendEvent(event: "health.update", payloadJSON: jsonString)
                    }
                }
            }
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil)

        case OpenClawHealthCommand.unsubscribe.rawValue:
            let params = try Self.decodeParams(OpenClawHealthSubscribeParams.self, from: req.paramsJSON)
            let types = params.types.compactMap { OpenClawHealthDataType(rawValue: $0) }
            await self.healthService.unsubscribe(types: types)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil)

        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown health command"))
        }
    }
```

**Step 3: Register in buildCapabilityRouter()**

After the motion registration block (around line 1577), add:

```swift
        register([
            OpenClawHealthCommand.query.rawValue,
            OpenClawHealthCommand.summary.rawValue,
            OpenClawHealthCommand.subscribe.rawValue,
            OpenClawHealthCommand.unsubscribe.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleHealthInvoke(req)
        }
```

**Step 4: Commit**

```bash
git add apps/ios/Sources/Model/NodeAppModel.swift
git commit -m "feat(health): integrate HealthService into NodeAppModel command router"
```

---

### Task 6: Register capability in GatewayConnectionController

**Files:**

- Modify: `apps/ios/Sources/Gateway/GatewayConnectionController.swift`
  - `currentCaps()` — add health capability check (after motion, around line 812)
  - `currentCommands()` — add health commands (after motion, around line 871)
  - `currentPermissions()` — add health permission status (after motion, around line 901)

**Step 1: Add to currentCaps()**

After the motion block (lines 810-812):

```swift
    if Self.motionAvailable() {
        caps.append(OpenClawCapability.motion.rawValue)
    }
```

Add:

```swift
        if HKHealthStore.isHealthDataAvailable() {
            caps.append(OpenClawCapability.health.rawValue)
        }
```

Also add `import HealthKit` at the top of the file.

**Step 2: Add to currentCommands()**

After the motion commands block (around line 871), add:

```swift
        if caps.contains(OpenClawCapability.health.rawValue) {
            commands.append(OpenClawHealthCommand.query.rawValue)
            commands.append(OpenClawHealthCommand.summary.rawValue)
            commands.append(OpenClawHealthCommand.subscribe.rawValue)
            commands.append(OpenClawHealthCommand.unsubscribe.rawValue)
        }
```

**Step 3: Add to currentPermissions()**

After the motion permission block (around line 901), add:

```swift
        if HKHealthStore.isHealthDataAvailable() {
            let store = HKHealthStore()
            let stepStatus = store.authorizationStatus(for: HKQuantityType(.stepCount))
            let heartStatus = store.authorizationStatus(for: HKQuantityType(.heartRate))
            let sleepStatus = store.authorizationStatus(for: HKCategoryType(.sleepAnalysis))
            permissions["health"] =
                stepStatus == .sharingAuthorized ||
                heartStatus == .sharingAuthorized ||
                sleepStatus == .sharingAuthorized
        }
```

Note: `authorizationStatus(for:)` returns `.sharingAuthorized` for write; for read access HealthKit only returns `.notDetermined` (privacy by design). This permission field is best-effort and used for gateway reporting, not for gating queries. Actual authorization happens in `HealthService.ensureAuthorization()`.

**Step 4: Commit**

```bash
git add apps/ios/Sources/Gateway/GatewayConnectionController.swift
git commit -m "feat(health): register health capability and commands in GatewayConnectionController"
```

---

### Task 7: Add HealthKit entitlement and Info.plist permission

**Files:**

- Modify: `apps/ios/Sources/OpenClaw.entitlements` — add HealthKit entitlement
- Modify: `apps/ios/Sources/Info.plist` — add `NSHealthShareUsageDescription`

**Step 1: Add entitlement**

In `apps/ios/Sources/OpenClaw.entitlements`, add inside the `<dict>`:

```xml
	<key>com.apple.developer.healthkit</key>
	<true/>
	<key>com.apple.developer.healthkit.access</key>
	<array/>
```

**Step 2: Add Info.plist permission description**

In `apps/ios/Sources/Info.plist`, add a new permission description entry (after the existing `NSSpeechRecognitionUsageDescription` block):

```xml
<key>NSHealthShareUsageDescription</key>
<string>OpenClaw reads your health data (steps, heart rate, sleep) to provide personalized insights when requested by the agent.</string>
```

**Step 3: Commit**

```bash
git add apps/ios/Sources/OpenClaw.entitlements apps/ios/Sources/Info.plist
git commit -m "feat(health): add HealthKit entitlement and usage description"
```

---

### Task 8: Add HEALTH_COMMANDS to Gateway node-command-policy.ts

**Files:**

- Modify: `src/gateway/node-command-policy.ts`
  - Add `HEALTH_COMMANDS` constant (after `MOTION_COMMANDS`, line 35)
  - Add `...HEALTH_COMMANDS` to `PLATFORM_DEFAULTS.ios` (after `...MOTION_COMMANDS`, line 65)

**Step 1: Add HEALTH_COMMANDS constant**

After line 35 (`const MOTION_COMMANDS = ["motion.activity", "motion.pedometer"];`), add:

```typescript
const HEALTH_COMMANDS = [
  "health.query",
  "health.summary",
  "health.subscribe",
  "health.unsubscribe",
];
```

**Step 2: Add to PLATFORM_DEFAULTS.ios**

After `...MOTION_COMMANDS,` (line 65) in the `ios` array, add:

```typescript
    ...HEALTH_COMMANDS,
```

**Step 3: Verify TypeScript compiles**

Run: `cd /Users/yixuan.yhl/developers/openclaw && pnpm tsgo --noEmit 2>&1 | grep -i error | head -5`

Expected: No errors (or unrelated errors only)

**Step 4: Commit**

```bash
git add src/gateway/node-command-policy.ts
git commit -m "feat(health): add health commands to iOS node command policy"
```

---

### Task 9: Build and verify

**Step 1: Build OpenClawKit**

Run: `cd /Users/yixuan.yhl/developers/openclaw/apps/shared/OpenClawKit && swift build 2>&1 | tail -5`

Expected: Build Succeeded

**Step 2: Build Gateway (TypeScript)**

Run: `cd /Users/yixuan.yhl/developers/openclaw && pnpm build 2>&1 | tail -5`

Expected: Build succeeded

**Step 3: Verify no lint issues**

Run: `cd /Users/yixuan.yhl/developers/openclaw && pnpm tsgo --noEmit 2>&1 | tail -5`

Expected: No type errors

**Step 4: Run existing tests**

Run: `cd /Users/yixuan.yhl/developers/openclaw && pnpm test -- --grep "node-command-policy" 2>&1 | tail -10`

Expected: All existing tests pass (HEALTH_COMMANDS are not in dangerous list, so no test changes needed)
