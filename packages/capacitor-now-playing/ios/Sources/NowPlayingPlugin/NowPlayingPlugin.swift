import Foundation
import Capacitor
import MediaPlayer
import UIKit

/**
 * Native iOS bridge to `MPNowPlayingInfoCenter` (the lock-screen / Control Center
 * "Now Playing" card). The `@jofr/capacitor-media-session` plugin ships no iOS
 * native code, so on iOS it only proxies to WKWebView's Web Media Session API —
 * which reliably wires play/pause controls to the playing `<audio>` element but
 * does NOT surface JS-set metadata (title/artist/artwork) or the position
 * scrubber for cross-origin web audio. This plugin sets `nowPlayingInfo`
 * directly so the system player shows real track data, artwork, and elapsed time.
 *
 * Scope is deliberately narrow: it owns the displayed *info* only. Transport
 * controls (play/pause/next/prev/seek) stay on the existing Web Media Session
 * path (which already works on iOS), so this plugin registers no
 * MPRemoteCommandCenter handlers and cannot conflict with WebKit's own.
 *
 * All `nowPlayingInfo` mutations are serialized on the main queue. Each write
 * re-asserts the full info dictionary so a WebKit-driven refresh of its own
 * session (which can blank our fields) is corrected on the next update — the
 * ~2 s position tick keeps the card sticky.
 */
@objc(NowPlayingPlugin)
public class NowPlayingPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NowPlayingPlugin"
    public let jsName = "NicotindNowPlaying"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setMetadata", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPlaybackState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPositionState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]

    /// The current Now Playing dictionary, mutated only on the main queue.
    private var info: [String: Any] = [:]
    /// Tracks the in-flight artwork URL so a late download for a previous track
    /// is ignored (avoids flashing stale art when tracks change quickly).
    private var artworkUrl: String?
    private var artworkTask: URLSessionDataTask?

    @objc func setMetadata(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? ""
        let artist = call.getString("artist") ?? ""
        let album = call.getString("album") ?? ""
        let url = call.getString("artworkUrl")

        DispatchQueue.main.async {
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
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        }
        call.resolve()
    }

    /// Push the current dictionary to the system. Must run on the main queue.
    private func apply() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    /// Fetch the artwork off the main thread, then merge it back in. The URL is
    /// the app's `/api/cover/...?token=` endpoint (auth via query param), so a
    /// plain GET succeeds without headers.
    private func loadArtwork(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        let task = URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let self = self, let data = data, let image = UIImage(data: data) else { return }
            DispatchQueue.main.async {
                // Ignore if the track changed while the image was downloading.
                guard self.artworkUrl == urlString else { return }
                self.info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                self.apply()
            }
        }
        artworkTask = task
        task.resume()
    }
}
