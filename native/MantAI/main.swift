import Foundation
import Speech
import Translation
import FoundationModels
import AVFoundation
import NaturalLanguage

struct AIError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
func require(_ condition: Bool, _ message: String) throws { if !condition { throw AIError(message: message) } }
let mantLanguages = ["en", "it", "es", "fr", "de", "ru"]

@available(macOS 26.0, *)
func check(_ engine: String, _ languages: [String]) async -> [String: Any] {
    if engine == "speech" {
        let supported = await SpeechTranscriber.supportedLocales.map { $0.language.languageCode?.identifier ?? "" }
        let installed = await SpeechTranscriber.installedLocales.map { $0.language.languageCode?.identifier ?? "" }
        var statuses: [String: String] = [:]
        let installedLocales = await SpeechTranscriber.installedLocales
        for language in Set(languages + mantLanguages.filter { supported.contains($0) }) {
            if let locale = installedLocales.first(where: { $0.language.languageCode?.identifier == language }) {
                let module = SpeechTranscriber(locale: locale, preset: .transcription)
                statuses[language] = String(describing: await AssetInventory.status(forModules: [module]))
            }
        }
        let missing = languages.filter { statuses[$0] != "installed" }
        let unsupported = languages.filter { !supported.contains($0) }
        return ["available": missing.isEmpty && SpeechTranscriber.isAvailable, "languages": Array(Set(supported)).sorted(), "installedLanguages": Array(Set(installed)).sorted(), "moduleStatus": statuses, "readyLanguages": statuses.filter { $0.value == "installed" }.keys.sorted(), "issue": !unsupported.isEmpty ? "Apple Speech does not support: \(unsupported.joined(separator: ", ")). Select another transcription backend." : missing.isEmpty ? "" : "Install Apple Speech assets for: \(missing.joined(separator: ", ")). Use a macOS speech app to download assets; Mant never downloads models automatically."]
    }
    if engine == "translation" {
        let supported = await LanguageAvailability().supportedLanguages.map { $0.languageCode?.identifier ?? "" }
        var pairs: [String: [String]] = [:]
        for source in mantLanguages where supported.contains(source) {
            pairs[source] = []
            for target in mantLanguages where supported.contains(target) && source != target {
                if await LanguageAvailability().status(from: Locale.Language(identifier: source), to: Locale.Language(identifier: target)) == .installed { pairs[source]?.append(target) }
            }
        }
        return ["available": languages.allSatisfy { supported.contains($0) }, "languages": Array(Set(supported)).sorted(), "pairs": pairs, "assets": "Language pairs are checked for installed assets on each translation request."]
    }
    let model = SystemLanguageModel.default
    let unsupported = languages.filter { !model.supportsLocale(Locale(identifier: $0)) }
    var result: [String: Any] = ["available": model.isAvailable && languages.allSatisfy { model.supportsLocale(Locale(identifier: $0)) }, "languages": model.supportedLanguages.map { $0.languageCode?.identifier ?? "" }.sorted(), "issue": model.isAvailable ? (unsupported.isEmpty ? "" : "Unsupported requested Foundation Models language: \(unsupported.joined(separator: ", ")).") : String(describing: model.availability)]
    // Context capacity became queryable in macOS 26.4. Older runtimes report
    // unknown rather than assuming a limit across OS/model revisions.
    if #available(macOS 26.4, *) { if model.contextSize > 0 { result["contextWindow"] = model.contextSize } }
    return result
}
@available(macOS 26.4, *)
func dynamicSchema(_ value: [String: Any], name: String = "MantResult") throws -> DynamicGenerationSchema {
    if let constant = value["const"] as? String { return .init(name: name, anyOf: [constant]) }
    if let choices = value["anyOf"] as? [[String: Any]] { return try .init(name: name, anyOf: choices.enumerated().map { try dynamicSchema($0.element, name: name + "Choice\($0.offset)") }) }
    if let values = value["enum"] as? [String] { return .init(name: name, anyOf: values) }
    switch value["type"] as? String {
    case "object":
        let properties = value["properties"] as? [String: [String: Any]] ?? [:]
        let required = value["required"] as? [String] ?? []
        return try .init(name: name, representNilExplicitlyInGeneratedContent: true, properties: properties.keys.sorted().map { key in
            .init(name: key, schema: try dynamicSchema(properties[key]!, name: name + "_" + key), isOptional: !required.contains(key))
        })
    case "array": return try .init(arrayOf: dynamicSchema(value["items"] as? [String: Any] ?? [:], name: name + "Item"), minimumElements: value["minItems"] as? Int, maximumElements: value["maxItems"] as? Int)
    case "string": return .init(type: String.self)
    case "integer": return .init(type: Int.self)
    case "number": return .init(type: Double.self)
    case "boolean": return .init(type: Bool.self)
    case "null": return .null
    default: throw AIError(message: "Foundation Models cannot represent this task schema. Select another backend.")
    }
}
@available(macOS 26.0, *)
func run(_ request: [String: Any]) async throws -> Any {
    let action = request["action"] as? String ?? "check"
    let languages = request["languages"] as? [String] ?? []
    if action == "check" { return await check(request["engine"] as? String ?? "foundation", languages) }
    if action == "translate" {
        let text = request["text"] as? String ?? ""
        let recognizer = NLLanguageRecognizer(); recognizer.processString(text)
        guard let source = recognizer.dominantLanguage?.rawValue, let target = request["targetLanguage"] as? String else { throw AIError(message: "Apple Translation cannot identify the source language.") }
        if source == target { return ["text": "", "sourceLanguage": source] }
        let from = Locale.Language(identifier: source), to = Locale.Language(identifier: target)
        let status = await LanguageAvailability().status(from: from, to: to)
        try require(status == .installed, "Apple Translation assets for \(source) → \(target) are not installed. Download this pair in the macOS Translate app.")
        let session = TranslationSession(installedSource: from, target: to)
        let result = try await session.translate(text)
        return ["text": result.targetText, "sourceLanguage": source]
    }
    if action == "generate" {
        guard #available(macOS 26.4, *) else { throw AIError(message: "Mant Foundation Models structured schemas require macOS 26.4+.") }
        let model = SystemLanguageModel.default
        try require(languages.allSatisfy { model.supportsLocale(Locale(identifier: $0)) }, "Foundation Models does not support the requested language. Choose another task backend.")
        try require(model.isAvailable, "Apple Intelligence is unavailable: \(model.availability)")
        let prompt = request["prompt"] as? String ?? ""
        // The application validates references and all constraints after decoding.
        let schema = try GenerationSchema(root: dynamicSchema(request["schema"] as? [String: Any] ?? [:]), dependencies: [])
        let promptTokens = try await model.tokenCount(for: Prompt(prompt))
        let schemaTokens = try await model.tokenCount(for: schema)
        try require(model.contextSize > promptTokens + schemaTokens + 512, "Foundation Models context capacity is incompatible with this task prompt and schema. Choose another backend or shorten the brief.")
        let result = try await LanguageModelSession(model: model).respond(to: prompt, schema: schema)
        return try JSONSerialization.jsonObject(with: Data(result.content.jsonString.utf8))
    }
    if action == "transcribe" {
        try require(languages.count == 1, "Apple Speech requires one explicit conversation language. Select it before starting transcription.")
        let installed = await SpeechTranscriber.installedLocales
        let preferred = installed.first { $0.language.languageCode?.identifier == languages[0] }
        let equivalent = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: languages[0]))
        guard let locale = preferred ?? equivalent else { throw AIError(message: "Apple Speech does not support \(languages[0]).") }
        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        let status = await AssetInventory.status(forModules: [transcriber])
        try require(status == .installed, "Apple Speech assets are missing for \(languages[0]). Install them using a macOS speech app.")
        guard let audioPath = request["path"] as? String else { throw AIError(message: "Missing WAV audio path.") }
        let path = URL(fileURLWithPath: audioPath)
        let file = try AVAudioFile(forReading: path)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let output = Task { () throws -> String in
            var text = ""
            for try await result in transcriber.results { text += String(result.text.characters) }
            return text
        }
        do {
            try await analyzer.start(inputAudioFile: file, finishAfterFile: true)
            return ["text": try await output.value]
        } catch { output.cancel(); await analyzer.cancelAndFinishNow(); throw error }
    }
    throw AIError(message: "Unknown Apple AI action.")
}
@main struct MantAI {
    static func main() async {
        do {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            try require(data.count <= 4_000_000, "Apple AI request exceeds 4 MB.")
            guard let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw AIError(message: "Invalid AI request.") }
            guard #available(macOS 26.0, *) else { throw AIError(message: "Apple AI engines require macOS 26+.") }
            let result = try await run(request)
            FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["result": result], options: [.sortedKeys]))
        } catch {
            let data = (try? JSONSerialization.data(withJSONObject: ["error": error.localizedDescription])) ?? Data()
            FileHandle.standardOutput.write(data); exit(1)
        }
    }
}
