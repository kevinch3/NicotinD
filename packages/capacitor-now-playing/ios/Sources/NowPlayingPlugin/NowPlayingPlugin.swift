import Foundation
import Capacitor
import MediaPlayer
import UIKit
import AVFoundation

/**
 * Native iOS bridge to `MPNowPlayingInfoCenter` (the lock-screen / Control Center
 * "Now Playing" card). The `@jofr/capacitor-media-session` plugin ships no iOS
 * native code, so on iOS it only proxies to WKWebView's Web Media Session API —
 * which wires play/pause to the playing `<audio>` element but does NOT surface
 * JS-set metadata (title/artist/artwork) or the position scrubber for
 * cross-origin web audio.
 *
 * iOS only *displays* `nowPlayingInfo` for the app that owns the system
 * now-playing session, and ownership requires (a) an **active AVAudioSession**
 * and (b) at least one **registered MPRemoteCommandCenter target**. WKWebView
 * has both for its `<audio>` element, so merely writing `nowPlayingInfo` (the
 * plugin's original, never-working behavior) lost to WebKit's empty session.
 * This plugin therefore takes ownership: it activates an `AVAudioSession` and
 * registers the lock-screen transport commands, forwarding each back to JS via a
 * single `remoteCommand` listener event so the Angular player responds.
 *
 * Because we now own the commands, the web layer **must not** also wire
 * WKWebView's Web Media Session `setActionHandler` on iOS, or every transport
 * action fires twice — see `MediaControlsService`. All `nowPlayingInfo`
 * mutations are serialized on the main queue.
 */
@objc(NowPlayingPlugin)
public class NowPlayingPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NowPlayingPlugin"
    public let jsName = "NicotindNowPlaying"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setMetadata", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPlaybackState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPositionState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDiagnostics", returnType: CAPPluginReturnPromise)
    ]

    /// The current Now Playing dictionary, mutated only on the main queue.
    private var info: [String: Any] = [:]
    /// Tracks the in-flight artwork URL so a late download for a previous track
    /// is ignored (avoids flashing stale art when tracks change quickly).
    private var artworkUrl: String?
    private var artworkTask: URLSessionDataTask?
    /// Idempotency guards for the one-time session + command setup.
    private var sessionConfigured = false
    private var commandsRegistered = false
    /// Last artwork outcome, surfaced via `getDiagnostics` for on-device debugging.
    private var lastArtworkStatus = "none"

    public override func load() {
        // Observable in Console.app / device logs to confirm the plugin actually
        // got registered into the (CI-generated) iOS project.
        print("NICOTIND_NOWPLAYING_LOADED")
    }

    @objc func setMetadata(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? ""
        let artist = call.getString("artist") ?? ""
        let album = call.getString("album") ?? ""
        let url = call.getString("artworkUrl")

        DispatchQueue.main.async {
            self.ensureSession()
            self.registerCommands()
            self.info[MPMediaItemPropertyTitle] = title
            self.info[MPMediaItemPropertyArtist] = artist
            self.info[MPMediaItemPropertyAlbumTitle] = album
            if url != self.artworkUrl {
                // New track (or artwork changed): drop the stale image, reload below.
                self.info[MPMediaItemPropertyArtwork] = nil
                self.artworkUrl = url
                self.artworkTask?.cancel()
            }
            self.apply()
            if let url = url, !url.isEmpty {
                self.loadArtwork(url)
            }
        }
        call.resolve()
    }

    @objc func setPlaybackState(_ call: CAPPluginCall) {
        let state = call.getString("state") ?? "none"
        DispatchQueue.main.async {
            self.ensureSession()
            self.registerCommands()
            self.info[MPNowPlayingInfoPropertyPlaybackRate] = state == "playing" ? 1.0 : 0.0
            self.apply()
            switch state {
            case "playing": MPNowPlayingInfoCenter.default().playbackState = .playing
            case "paused": MPNowPlayingInfoCenter.default().playbackState = .paused
            default: MPNowPlayingInfoCenter.default().playbackState = .stopped
            }
        }
        call.resolve()
    }

    @objc func setPositionState(_ call: CAPPluginCall) {
        let duration = call.getDouble("duration") ?? 0
        let position = call.getDouble("position") ?? 0
        let rate = call.getDouble("playbackRate") ?? 1.0
        DispatchQueue.main.async {
            self.info[MPMediaItemPropertyPlaybackDuration] = duration
            self.info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
            self.info[MPNowPlayingInfoPropertyPlaybackRate] = rate
            self.apply()
        }
        call.resolve()
    }

    @objc func clear(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.artworkTask?.cancel()
            self.info = [:]
            self.artworkUrl = nil
            self.lastArtworkStatus = "none"
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            // Release the session so other apps' audio can resume.
            try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
            self.sessionConfigured = false
        }
        call.resolve()
    }

    /// Snapshot of plugin/session state for the in-app diagnostics panel.
    @objc func getDiagnostics(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let session = AVAudioSession.sharedInstance()
            call.resolve([
                "pluginRegistered": true,
                "sessionConfigured": self.sessionConfigured,
                "audioCategory": session.category.rawValue,
                "isOtherAudioPlaying": session.isOtherAudioPlaying,
                "commandsRegistered": self.commandsRegistered,
                "nowPlayingInfoKeys": Array(self.info.keys),
                "artworkUrl": self.artworkUrl ?? "",
                "lastArtworkStatus": self.lastArtworkStatus
            ])
        }
    }

    /// Activate a playback audio session so iOS treats us as a now-playing app.
    /// Idempotent and lazy (only on first real playback) to avoid grabbing the
    /// session before the user plays anything. `.playback` matches what WKWebView
    /// itself uses for an audio element, minimizing disruption to the working
    /// background playback. Must run on the main queue.
    private func ensureSession() {
        guard !sessionConfigured else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default)
        try? session.setActive(true)
        sessionConfigured = true
    }

    /// Register lock-screen / Control Center transport commands. Each forwards a
    /// single `remoteCommand` event to JS (action discriminator mirrors the web
    /// `MediaAction` union); the web layer owns the actual playback response.
    /// Idempotent. Must run on the main queue.
    private func registerCommands() {
        guard !commandsRegistered else { return }
        let cc = MPRemoteCommandCenter.shared()

        cc.playCommand.addTarget { [weak self] _ in
            self?.notifyListeners("remoteCommand", data: ["action": "play"]); return .success
        }
        cc.pauseCommand.addTarget { [weak self] _ in
            self?.notifyListeners("remoteCommand", data: ["action": "pause"]); return .success
        }
        cc.nextTrackCommand.addTarget { [weak self] _ in
            self?.notifyListeners("remoteCommand", data: ["action": "nexttrack"]); return .success
        }
        cc.previousTrackCommand.addTarget { [weak self] _ in
            self?.notifyListeners("remoteCommand", data: ["action": "previoustrack"]); return .success
        }
        cc.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.notifyListeners("remoteCommand", data: ["action": "seekto", "seekTime": e.positionTime])
            return .success
        }
        for command in [cc.playCommand, cc.pauseCommand, cc.nextTrackCommand,
                        cc.previousTrackCommand, cc.changePlaybackPositionCommand] {
            command.isEnabled = true
        }

        commandsRegistered = true
    }

    /// Push the current dictionary to the system. Must run on the main queue.
    private func apply() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    /// Fetch the artwork off the main thread, then merge it back in. The URL is
    /// the app's `/api/cover/...?token=` endpoint (auth via query param), so a
    /// plain GET succeeds without headers. Failures are recorded + emitted as an
    /// `artworkError` event so the diagnostics panel can surface ATS/network
    /// issues (the most common cause of a metadata-but-no-thumbnail card).
    private func loadArtwork(_ urlString: String) {
        guard let url = URL(string: urlString) else {
            lastArtworkStatus = "invalid-url"
            notifyListeners("artworkError", data: ["url": urlString, "message": "invalid url"])
            return
        }
        lastArtworkStatus = "loading"
        let task = URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            guard let self = self else { return }
            if let error = error {
                self.lastArtworkStatus = "error: \(error.localizedDescription)"
                self.notifyListeners("artworkError", data: ["url": urlString, "message": error.localizedDescription])
                return
            }
            guard let data = data, let image = UIImage(data: data) else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? -1
                self.lastArtworkStatus = "bad-response: \(code)"
                self.notifyListeners("artworkError", data: ["url": urlString, "status": code])
                return
            }
            DispatchQueue.main.async {
                // Ignore if the track changed while the image was downloading.
                guard self.artworkUrl == urlString else { return }
                self.info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                self.lastArtworkStatus = "ok"
                self.apply()
            }
        }
        artworkTask = task
        task.resume()
    }
}
