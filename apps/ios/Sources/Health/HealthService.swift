import Foundation
import HealthKit
import OpenClawKit

actor HealthService: HealthKitServicing {
    private let store = HKHealthStore()
    private var observerQueries: [HKObjectType: HKObserverQuery] = [:]

    deinit {
        for (objectType, query) in observerQueries {
            store.stop(query)
            store.disableBackgroundDelivery(for: objectType) { _, _ in }
        }
    }

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

                // Notify HealthKit immediately that we received the update.
                // Fetch latest samples asynchronously — the data will still be there.
                completionHandler()

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
