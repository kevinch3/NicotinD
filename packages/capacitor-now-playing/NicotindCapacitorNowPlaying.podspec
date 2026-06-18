require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'NicotindCapacitorNowPlaying'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://github.com/kevinch3/nicotind'
  s.author = 'NicotinD'
  s.source = { :git => 'https://github.com/kevinch3/nicotind.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m}'
  # Must be <= Capacitor's own pod target (13.0 on Capacitor 6.2), or the
  # generated Podfile (platform :ios, '13.0') rejects this pod as requiring a
  # higher minimum deployment target. MPNowPlayingInfoCenter is iOS 11+.
  s.ios.deployment_target = '13.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.1'
end
