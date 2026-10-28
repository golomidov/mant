import Foundation
import AppKit
import AVFoundation
import ScreenCaptureKit
import CoreMedia
import CoreAudio
import Darwin

private func hostMs() -> Double { CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())) * 1000 }
private func die(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1)
}
private struct CaptureError: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
// Capture callbacks never wait on a pipe. Pending output is bounded; a blocked
// consumer ends capture visibly rather than retaining an expanding audio queue.
private final class Writer: @unchecked Sendable {
    let queue = DispatchQueue(label: "mant.ipc")
    let lock = NSLock()
    var pending = 0
    var started = false
    var startup: [Data] = []
    func send(_ header: [String: Any], _ pcm: Data = Data()) {
        guard let json = try? JSONSerialization.data(withJSONObject: header) else { return }
        var j = UInt32(json.count).littleEndian, a = UInt32(pcm.count).littleEndian
        var data = Data(bytes: &j, count: 4)
        data.append(Data(bytes: &a, count: 4)); data.append(json); data.append(pcm)
        lock.lock(); pending += data.count; let overflow = pending > 1_048_576
        if overflow { die("Native IPC backpressure exceeded 1 MB; capture stopped.") }
        if !started { startup.append(data); lock.unlock(); return }
        enqueue(data)
        lock.unlock()
    }
    private func enqueue(_ packet: Data) {
        queue.async {
            do { try FileHandle.standardOutput.write(contentsOf: packet) }
            catch { die("Capture consumer disconnected.") }
            self.lock.lock(); self.pending -= packet.count; self.lock.unlock()
        }
    }
    func activate(_ header: [String: Any]) {
        // Keep startup callbacks behind the successful stream/clock handshake.
        let json = try! JSONSerialization.data(withJSONObject: header)
        var j = UInt32(json.count).littleEndian, a = UInt32(0)
        var packet = Data(bytes: &j, count: 4)
        packet.append(Data(bytes: &a, count: 4)); packet.append(json)
        lock.lock()
        pending += packet.count; enqueue(packet)
        for data in startup { enqueue(data) }
        startup.removeAll(); started = true
        lock.unlock()
    }
    func flush() { queue.sync {} }
}
private final class AudioSink: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate, SCStreamOutput {
    let source: String
    let writer: Writer
    let queue: DispatchQueue
    var sequence = 0
    var session: AVCaptureSession?
    var converter: AVAudioConverter?
    var inputFormat: AVAudioFormat?
    init(_ source: String, _ writer: Writer) {
        self.source = source; self.writer = writer
        queue = DispatchQueue(label: "mant.audio.\(source)")
    }
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        consume(sampleBuffer, clock: session?.synchronizationClock)
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        if type == .audio { consume(sampleBuffer, clock: nil) }
    }
    func consume(_ sample: CMSampleBuffer, clock: CMClock?) {
        guard CMSampleBufferDataIsReady(sample), let description = CMSampleBufferGetFormatDescription(sample) else { return }
        let format = AVAudioFormat(cmAudioFormatDescription: description)
        let count = CMSampleBufferGetNumSamples(sample)
        guard count > 0, let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true) else { return }
        input.frameLength = AVAudioFrameCount(count)
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(count), into: input.mutableAudioBufferList)
        if status != noErr { writer.send(["type": "error", "message": "Cannot read \(source) PCM (\(status))."]); return }
        if inputFormat != format {
            // Rebuild the converter in place: a sample-rate change alone does not
            // change the selected physical microphone or output identity.
            inputFormat = format; converter = AVAudioConverter(from: format, to: target)
        }
        guard let converter = converter,
              let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(ceil(Double(count) * 24000 / format.sampleRate)) + 128) else { return }
        var supplied = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true; status.pointee = .haveData; return input
        }
        if let error = error { writer.send(["type": "error", "message": error.localizedDescription]); return }
        guard output.frameLength > 0, let bytes = output.int16ChannelData else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        let host = clock.map { CMSyncConvertTime(pts, from: $0, to: CMClockGetHostTimeClock()) } ?? pts
        let time = CMTimeGetSeconds(host) * 1000
        guard time.isFinite, time >= 0, abs(time - hostMs()) < 5000 else {
            writer.send(["type": "error", "message": "Invalid \(source) host timestamp; restart capture."]); return
        }
        writer.send(["type": "audio", "sourceId": source, "sequence": sequence, "captureMs": time,
                     "sampleRate": 24000, "channels": 1, "format": "pcm_s16le", "frames": Int(output.frameLength)],
                    Data(bytes: bytes[0], count: Int(output.frameLength) * 2))
        sequence += 1
    }
}
private final class StreamDelegate: NSObject, SCStreamDelegate {
    let writer: Writer
    init(_ writer: Writer) { self.writer = writer }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        writer.send(["type": "error", "message": "Playback capture stopped: \(error.localizedDescription)"])
    }
}
private func devices() -> [AVCaptureDevice] {
    AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInMicrophone, .externalUnknown], mediaType: .audio, position: .unspecified).devices
}
private func inputDevice(_ id: String) throws -> AVCaptureDevice {
    guard let device = devices().first(where: { $0.uniqueID == id }) else { throw CaptureError(message: "Selected audio input disappeared. Refresh devices.") }
    return device
}
private func permissionName() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "granted"
    case .notDetermined: return "not-requested"
    case .denied: return "denied"
    case .restricted: return "restricted"
    @unknown default: return "unknown"
    }
}
private func outputRoute() -> String {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var id = AudioDeviceID(0), size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr else { return "unknown-output" }
    var uid: Unmanaged<CFString>?
    address.mSelector = kAudioDevicePropertyDeviceUID; size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &uid) == noErr,
          let identity = uid?.takeRetainedValue() else { return "unknown-output" }
    return "output:\(identity)"
}
@main private struct Main {
    @MainActor static func main() async {
        let arguments = CommandLine.arguments
        if arguments.contains("--probe") {
            print("macOS \(ProcessInfo.processInfo.operatingSystemVersionString); ScreenCaptureKit audio macOS 13+; \(cpu())")
            return
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let writer = Writer()
        do {
            if arguments.contains("--list") {
                var result: [String: Any] = ["os": ProcessInfo.processInfo.operatingSystemVersionString, "architecture": cpu(), "minimumMacOS": "13.0", "supported": true,
                    "microphonePermission": permissionName(), "playbackPermission": CGPreflightScreenCaptureAccess() ? "granted" : "not-granted",
                    "microphones": devices().map { ["id": $0.uniqueID, "name": $0.localizedName] }, "targets": [], "routeSignature": outputRoute()]
                do {
                    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                    let grouped = Dictionary(grouping: content.applications.filter { !$0.bundleIdentifier.isEmpty }, by: { $0.bundleIdentifier })
                    result["targets"] = grouped.keys.sorted().map { bundle -> [String: Any] in
                        let apps = grouped[bundle]!
                        return ["id": bundle, "bundleId": bundle, "name": apps[0].applicationName, "pids": apps.map { Int($0.processID) }]
                    }
                    result["playbackPermission"] = "granted"
                } catch { result["problem"] = "Playback permission or target enumeration: \(error.localizedDescription)" }
                let data = try JSONSerialization.data(withJSONObject: result)
                FileHandle.standardOutput.write(data); return
            }
            guard let configData = readLine()?.data(using: .utf8),
                  let config = try JSONSerialization.jsonObject(with: configData) as? [String: Any],
                  let microphoneID = config["microphoneId"] as? String,
                  let remote = config["remote"] as? [String: String] else { throw CaptureError(message: "Missing capture configuration.") }
            guard await AVCaptureDevice.requestAccess(for: .audio) else { throw CaptureError(message: "Microphone permission denied. Enable Mant Capture in System Settings → Privacy & Security → Microphone, then restart.") }
            var sessions: [AVCaptureSession] = [], sinks: [AudioSink] = []
            var observers: [NSObjectProtocol] = []
            func openInput(_ id: String, _ source: String) throws {
                let device = try inputDevice(id)
                let session = AVCaptureSession(), sink = AudioSink(source, writer)
                let input = try AVCaptureDeviceInput(device: device), output = AVCaptureAudioDataOutput()
                guard session.canAddInput(input), session.canAddOutput(output) else { throw CaptureError(message: "Cannot open selected input.") }
                session.addInput(input); session.addOutput(output)
                output.setSampleBufferDelegate(sink, queue: sink.queue); sink.session = session
                for name in [AVCaptureSession.runtimeErrorNotification, AVCaptureSession.wasInterruptedNotification] {
                    observers.append(NotificationCenter.default.addObserver(forName: name, object: session, queue: nil) { _ in
                        writer.send(["type": "error", "message": "\(source) interrupted or disconnected. Stop, refresh devices and recheck separation."])
                    })
                }
                sessions.append(session); sinks.append(sink)
            }
            try openInput(microphoneID, "local-microphone")
            var stream: SCStream?
            let delegate = StreamDelegate(writer)
            let route = outputRoute()
            var selectedPIDs: Set<pid_t> = []
            if remote["kind"] == "input", let id = remote["deviceId"] {
                guard id != microphoneID else { throw CaptureError(message: "Local and playback inputs must differ.") }
                try openInput(id, "remote-playback")
            } else if remote["kind"] == "application", let bundle = remote["bundleId"] {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                let apps = content.applications.filter { $0.bundleIdentifier == bundle }
                guard let display = content.displays.first, !apps.isEmpty else { throw CaptureError(message: "Playback target unavailable. Start the call application and refresh targets.") }
                selectedPIDs = Set(apps.map { $0.processID })
                let filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
                let configuration = SCStreamConfiguration()
                configuration.capturesAudio = true; configuration.excludesCurrentProcessAudio = true
                configuration.sampleRate = 48000; configuration.channelCount = 2
                // No screen output is registered or transported.
                configuration.width = 2; configuration.height = 2; configuration.queueDepth = 3
                configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
                let sink = AudioSink("remote-playback", writer); sinks.append(sink)
                stream = SCStream(filter: filter, configuration: configuration, delegate: delegate)
                try stream!.addStreamOutput(sink, type: .audio, sampleHandlerQueue: sink.queue)
            } else { throw CaptureError(message: "Choose playback application or separate input.") }
            let center = NSWorkspace.shared.notificationCenter
            for name in [NSWorkspace.willSleepNotification, NSWorkspace.didWakeNotification] {
                observers.append(center.addObserver(forName: name, object: nil, queue: nil) { _ in
                    writer.send(["type": "error", "message": "Mac sleep/wake interrupted capture. Restart and recheck separation."])
                })
            }
            observers.append(NotificationCenter.default.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: nil, queue: nil) { note in
                if let device = note.object as? AVCaptureDevice, device.uniqueID == microphoneID || device.uniqueID == remote["deviceId"] {
                    writer.send(["type": "error", "message": "Selected headset/input disconnected. Refresh devices and recheck separation."])
                }
            })
            // Re-resolve the selected bundle, including all its current processes.
            // A changed process set is an explicit discontinuity, never a silent retarget.
            let monitor = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    if Task.isCancelled { break }
                    if outputRoute() != route { writer.send(["type": "error", "routeSignature": outputRoute(), "message": "Physical output device changed. Reconnecting; separation needs rechecking."]); break }
                    if let bundle = remote["bundleId"] {
                        do {
                            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                            let pids = Set(content.applications.filter { $0.bundleIdentifier == bundle }.map { $0.processID })
                            if pids != selectedPIDs { writer.send(["type": "error", "message": "Playback application processes changed. Reconnecting to the same application."]); break }
                        } catch { writer.send(["type": "error", "message": "Playback permission/target lost: \(error.localizedDescription)"]); break }
                    }
                    if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized { writer.send(["type": "error", "message": "Microphone permission revoked."]); break }
                }
            }
            let origin = hostMs()
            for session in sessions {
                session.startRunning()
                guard session.isRunning else { throw CaptureError(message: "Selected audio input did not start.") }
            }
            if let stream = stream { try await stream.startCapture() }
            writer.activate(["type": "ready", "clockMs": origin, "readyMs": hostMs(), "routeSignature": route])
            // EOF (including parent exit) releases every capture resource. No call controls.
            await withCheckedContinuation { continuation in
                DispatchQueue.global().async { while let line = readLine() { if line == "stop" { break } }; continuation.resume() }
            }
            monitor.cancel()
            if let stream = stream { try? await stream.stopCapture() }
            for session in sessions { session.stopRunning() }
            for observer in observers { NotificationCenter.default.removeObserver(observer); center.removeObserver(observer) }
            withExtendedLifetime((sinks, delegate)) {}
            writer.flush()
        } catch {
            // A failed startup must never emit a ready handshake.
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            writer.flush(); exit(1)
        }
    }
    static func cpu() -> String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x86_64"
        #endif
    }
}
