# iOS Apple Health Integration Design

## Overview

Add HealthKit integration to the iOS Node, enabling Agent to query health data and receive real-time updates via the existing `node.event` push mechanism.

**Approach**: On-demand query (primary) + HKObserverQuery push (secondary), following the existing Motion capability pattern.

**MVP Data Types**: stepCount, heartRate, sleepAnalysis

## Commands

| Command              | Direction     | Description                                        |
| -------------------- | ------------- | -------------------------------------------------- |
| `health.query`       | Agent -> Node | Query sample data by type + time range + limit     |
| `health.summary`     | Agent -> Node | Query aggregated statistics (hourly/daily/weekly)  |
| `health.subscribe`   | Agent -> Node | Subscribe to data type changes via HKObserverQuery |
| `health.unsubscribe` | Agent -> Node | Cancel subscription                                |

### Event (Node -> Gateway)

| Event           | Description                                      |
| --------------- | ------------------------------------------------ |
| `health.update` | Pushed when subscribed data type has new samples |

## Data Models (OpenClawKit)

### Command Enum

```swift
public enum OpenClawHealthCommand: String, Codable, Sendable {
    case query = "health.query"
    case summary = "health.summary"
    case subscribe = "health.subscribe"
    case unsubscribe = "health.unsubscribe"
}
```

### Data Type Enum

```swift
public enum OpenClawHealthDataType: String, Codable, Sendable {
    case stepCount
    case heartRate
    case sleepAnalysis
}
```

### health.query

```swift
public struct OpenClawHealthQueryParams: Codable, Sendable {
    public var type: String          // "stepCount" | "heartRate" | "sleepAnalysis"
    public var startISO: String?     // default: today 00:00
    public var endISO: String?       // default: now
    public var limit: Int?           // default: 100, max: 500
    public var ascending: Bool?      // default: false (newest first)
}

public struct OpenClawHealthQueryPayload: Codable, Sendable {
    public var type: String
    public var startISO: String
    public var endISO: String
    public var samples: [OpenClawHealthSample]
}

public struct OpenClawHealthSample: Codable, Sendable {
    public var dateISO: String
    public var endDateISO: String?
    public var value: Double?         // stepCount=count, heartRate=bpm
    public var unit: String?          // "count", "bpm", nil (sleep)
    public var category: String?      // sleep only: "asleep", "inBed", "awake", "rem", "core", "deep"
    public var source: String?        // source device name
}
```

### health.summary

```swift
public struct OpenClawHealthSummaryParams: Codable, Sendable {
    public var type: String           // "stepCount" | "heartRate"
    public var startISO: String?
    public var endISO: String?
    public var interval: String?      // "hour" | "day" | "week" - default: "day"
}

public struct OpenClawHealthSummaryPayload: Codable, Sendable {
    public var type: String
    public var interval: String
    public var statistics: [OpenClawHealthStatistic]
}

public struct OpenClawHealthStatistic: Codable, Sendable {
    public var startISO: String
    public var endISO: String
    public var sum: Double?           // stepCount uses sum
    public var average: Double?       // heartRate uses average
    public var min: Double?
    public var max: Double?
    public var unit: String
}
```

### health.subscribe / unsubscribe

```swift
public struct OpenClawHealthSubscribeParams: Codable, Sendable {
    public var types: [String]        // ["heartRate", "stepCount"]
}

// health.update event payload (Node -> Gateway push)
public struct OpenClawHealthUpdatePayload: Codable, Sendable {
    public var type: String
    public var latestSamples: [OpenClawHealthSample]
}
```

## iOS Implementation

### File Structure

```
apps/ios/Sources/Health/
  HealthService.swift               # Core service wrapping HKHealthStore
  HealthSubscriptionManager.swift   # Manages HKObserverQuery lifecycle

apps/shared/OpenClawKit/Sources/OpenClawKit/
  HealthCommands.swift              # Command enum + Params/Payload types
  Capabilities.swift                # Add case health
```

### HealthService

```swift
final class HealthService {
    private let store = HKHealthStore()
    private let subscriptionManager = HealthSubscriptionManager()

    func ensureAuthorization(for types: [OpenClawHealthDataType]) async throws
    func query(params: OpenClawHealthQueryParams) async throws -> OpenClawHealthQueryPayload
    func summary(params: OpenClawHealthSummaryParams) async throws -> OpenClawHealthSummaryPayload
    func subscribe(types: [OpenClawHealthDataType], onUpdate: @escaping (OpenClawHealthUpdatePayload) -> Void)
    func unsubscribe(types: [OpenClawHealthDataType])
}
```

### Data Type Mapping

```swift
extension OpenClawHealthDataType {
    var hkObjectType: HKObjectType? {
        switch self {
        case .stepCount:     return HKQuantityType(.stepCount)
        case .heartRate:     return HKQuantityType(.heartRate)
        case .sleepAnalysis: return HKCategoryType(.sleepAnalysis)
        }
    }

    var hkUnit: HKUnit? {
        switch self {
        case .stepCount:     return .count()
        case .heartRate:     return HKUnit.count().unitDivided(by: .minute())
        case .sleepAnalysis: return nil
        }
    }
}
```

### Subscribe Push Flow

```
health.subscribe { types: ["heartRate"] }
  -> HealthService.subscribe()
  -> HKObserverQuery(heartRate) callback fires
  -> HKSampleQuery fetches latest 5 new samples
  -> onUpdate callback
  -> NodeAppModel sends: node.event { event: "health.update", payload: {...} }
  -> store.enableBackgroundDelivery(for: heartRate, frequency: .immediate)
```

### NodeAppModel Integration

Register in `buildCapabilityRouter()`:

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

### GatewayConnectionController Integration

```swift
// currentCaps():
if HKHealthStore.isHealthDataAvailable() {
    caps.append(OpenClawCapability.health.rawValue)
}

// currentCommands():
if caps.contains(OpenClawCapability.health.rawValue) {
    commands.append(contentsOf: [
        OpenClawHealthCommand.query.rawValue,
        OpenClawHealthCommand.summary.rawValue,
        OpenClawHealthCommand.subscribe.rawValue,
        OpenClawHealthCommand.unsubscribe.rawValue,
    ])
}
```

### Info.plist

```xml
<key>NSHealthShareUsageDescription</key>
<string>OpenClaw needs access to your health data to provide personalized insights</string>
<key>UIBackgroundModes</key>
<array>
    <string>processing</string>
</array>
```

Plus HealthKit entitlement in Xcode project.

## Gateway Changes

Minimal — only add to command policy:

```typescript
// node-command-policy.ts
const HEALTH_COMMANDS = ["health.query", "health.summary", "health.subscribe", "health.unsubscribe"];

// PLATFORM_DEFAULTS.ios:
ios: [
    ...existing,
    ...HEALTH_COMMANDS,
],
```

The `node.event` channel already exists. `health.update` events are transparently forwarded by Gateway to Agent — no new handler needed.

## Permissions & Privacy

- HealthKit requires per-type read authorization (no blanket access)
- Authorization dialog triggered on first `health.query` / `health.subscribe` call
- Read-only access (no writing to HealthKit)
- `health.query` and `health.subscribe` should be in the default allow-list (not dangerous)
- Apple Watch data is automatically aggregated by HealthKit — no extra handling needed

## Future Expansion

After MVP, additional data types can be added by extending `OpenClawHealthDataType`:

- `bodyMass`, `bloodPressureSystolic`, `bloodPressureDiastolic`
- `bodyTemperature`, `oxygenSaturation`, `respiratoryRate`
- `activeEnergyBurned`, `workoutType`
- `electrocardiogram` (ECG)
