# LLP 0015: Physical device preview

**Type:** Explainer
**Status:** Draft
**Systems:** Hub, HubClient, HubComponents, AppleUtils, AndroidUtils
**Author:** Codex, directed by aPinix (human review pending)
**Date:** 2026-10-28
**Related:** [LLP 0000](0000-expo-device-hub.explainer.md), [LLP 0013](0013-hub-client-input-and-control.explainer.md)

## Scope and governing constraints

Physical Android discovery, physical iPhone/iPad discovery and preview, and
captured-screen annotations are the scope. The governing foundation is
[LLP 0000](0000-expo-device-hub.explainer.md); the existing input presentation is
described in the in-flight [LLP 0013](0013-hub-client-input-and-control.explainer.md).
The applicable constraints are LLP 0000#ui-matches-website,
LLP 0000#hub-client-separate, LLP 0000#emu-input-path, and LLP 0000#same-behavior.

## Independent discovery

Android command-line tools and ADB are queried independently. A missing
`avdmanager`, an unreadable AVD config, or a phone disconnecting during `getprop`
does not erase the other discovered devices. The first failure still appears in
the result's `error` field [observed: `hub-android-utils/src/list-devices.ts`].

Xcode 27 `devicectl` JSON schema 5 lists physical iPhones and iPads separately
from `simctl`. Only devices reporting `connection.state = connected` enter Hub's
running-device list. Remembered disconnected phones and watches are excluded;
failure does not remove simulator results [observed: `hub-apple-utils/src/physical-devices.ts`,
`expo-device-hub/src/server/devices.ts`]. Physical devices have no Hub shutdown or
delete control [observed: `Dashboard.tsx`].

A failed physical iOS query retains the last successful result for at most one
minute, with the error still reported. This avoids resetting a working preview
when Xcode times out. A successful query replaces that result immediately
[observed: `hub-apple-utils/src/physical-devices.ts`].

The sidebar keeps the existing Simulators and Emulators groups and adds separate
iOS Devices and Android Devices groups. Only the virtual-device groups offer
creation controls [observed: `hub-components/src/dashboard/Sidebar.tsx`].

## Physical iOS transport

The optional Rust Node-API backend is fetched from a pinned commit of Callstack's
MIT-licensed mobile development plugin and verified with SHA-256. Source stays in
ignored build output; a small committed patch removes telemetry and renames the
crate, retaining its license notices and pinned dependencies. Build it with `build:ios-device`;
ordinary simulator and Android builds do not require Rust [observed:
`expo-device-hub/native/ios-device/NOTICE.md`, `scripts/build-ios-device.ts`].

The backend uses CoreDevice displayservice and UniversalHID over the existing
trusted device connection, with no app installation. This is a private protocol
and may change with Xcode/iOS releases [observed: `native/ios-device/src/addon.rs`].
The native bounded queue, decoder generations, per-stream stop IDs and held-touch
release follow the reference implementation [observed: `addon.rs`, `input.rs`, `queue.rs`].

### Session ownership

The Hub's existing HTTP authentication gate covers `/api/ios-device/*`. The
adapter also rejects foreign browser origins, validates connected device IDs,
honors platform/session restrictions, limits concurrent captures and request
bodies, and expires abandoned sessions. Only a generation with a keyframe can
accept input. Normalized Hub coordinates are converted to the native backend's
pixel coordinates before dispatch. Closing one viewer stops only that viewer's
native stream [observed: `src/server/physical-ios.ts`].

The native patch reads SpringBoard's interface orientation at the beginning of
each gesture and maps displayed coordinates to the portrait digitizer. This is
needed for landscape iPads; the display stream is already rotated, while
UniversalHID coordinates are not. Video recovery releases native contacts, so the
browser drops remaining move/up events from the old generation [observed:
`scripts/ios-device.patch`, `hub-client/src/usePhysicalIosDevice.ts`].

The browser long-polls compressed HEVC batches and decodes them with WebCodecs.
It serializes touch writes, coalesces unsent moves, bounds decoder backlog, closes
VideoFrames after drawing, and closes its session when the selection changes.
Physical iOS supports screen viewing, single-contact taps/drags, local screenshots,
and annotations. Keyboard, multi-touch, hardware buttons, app metadata, accessibility,
logs, recording, device settings and simulated location are not offered by this
adapter [observed: `hub-client/src/usePhysicalIosDevice.ts`, `NOOP_DEVICE_CLIENT`].

## Annotations

Both platforms use the same annotation dialog. It freezes a screenshot, accepts
a normalized rectangular region and text note, and downloads a PNG containing
the marked screenshot and note. The live device receives no annotation gestures.
Closing the dialog releases its object URL; switching devices discards its state
[observed: `hub-components/src/dashboard/ScreenshotAnnotation.tsx`].

## Review questions

- Maintainers need to decide how to build/distribute the optional Rust addon in
  releases and whether to share it with the reference project [inferred].
- The native adapter dependency, Android regression fix, and annotation UI can be
  reviewed as separate contributions before an upstream PR [inferred].
- This fork has no fallback decoder for browsers lacking HEVC; it shows an
  actionable error [observed: `usePhysicalIosDevice.ts`].

## Validation in the fork

Codex ran the standard build, typecheck, lint, LLP reference check, affected package
tests, native tests, and an npm pack dry run on an Apple Silicon Mac on 2026-10-28.
The affected suites passed 1,558 tests; the native suite passed 68. One existing
client timing test failed once during parallel checks, then passed both in
isolation and in a complete client-suite rerun. The package dry run included the
native addon and its license notices [observed: local command results].

Live previews were checked with an iPhone 16 Pro, iPad Pro M5, and Samsung Galaxy
S25 FE. A Samsung tap launched an app; the landscape iPad camera zoom control
responded after the orientation correction. An iPad screenshot was annotated
with a region and note and downloaded as a PNG. The device locked during the final
pass, so an additional unlocked-app touch check remains for the human reviewer.
Hardware screenshots and identifiers are not committed [observed: local browser
checks by Codex; human review pending].
