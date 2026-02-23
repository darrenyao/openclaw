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
