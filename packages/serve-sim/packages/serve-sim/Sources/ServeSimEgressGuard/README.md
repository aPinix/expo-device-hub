# Resident egress guard

The guard stays loaded while its policy switches between pass-through and block.
This directory contains the native dylib, shared policy page, control helper and
host tests. [LLP 0007.001](../../../../../../llp/0007.001-runtime-egress-local.plan.md)
describes the capability-loader and startup/adoption integration.

Build recipes and package entries are present. The guard compiles against
Simulator SDKs 26.4 and 27.1, and host controller/probe contracts pass. Full package
builds and Simulator integration have not run. The guard is registered and initial/adoption CLI choices are parsed.
Explicit startup rejects before boot, app actions or ready output. Private
adoption checks compatibility before claiming, then rejects at enforcement
admission before capture/video setup; that claim stays consumed. There is no
bypass flag.
The initial performance gate failed, and all-process coverage, draining and
Simulator validation remain open. Uninstrumented sessions without an egress
request retain their existing path, including one-shot adoption, capture and
recording. The EAS cold fallback is unchanged.

The guard must be preloaded at process startup. Its startup capability record
supplies `SERVE_SIM_EGRESS_POLICY_FILE`, pointing to a private control page created
before startup. Host tests use an explicit compile-time constructor adapter;
production initialization requires the loader's all-process startup entry point. The host control helper requires an explicit
`create /absolute/page passthrough|block`; `set` publishes a mode/generation on
the same inode. There is no warmup default. Missing or invalid state blocks
covered remote calls. Unix sockets, files and resolved loopback peers continue;
unresolved Internet stream peers fail closed, even when they will become loopback
connections. Addressed UDP may use a permitted destination without a peer.
`status` checks the page, not whether the guard is loaded in another process.

Pass-through is an atomic check followed by the original operation. Block mode
checks destinations on connect/connectx and sendto/sendmsg, and the peer on
destination-less send/write/writev (including relevant NOCANCEL symbols). No fd
cache is used. Destination classification follows build-tools' guard; event
logging/reporting is not implemented here.

Publication does not drain calls that previously sampled pass-through. Direct
syscalls, sendfile/sendmsg_x, other interposers introduced by late dlopen,
uninstrumented processes and concurrent fd replacement between check/use are
outside coverage. Simulator-external processes are outside the guard. Never
unlink, replace or truncate a live page: existing processes keep its mapping;
truncation can fault. These lifecycle conditions need an owning boot integration.

Run on macOS with clang and Python's standard library, with no Simulator:

```sh
python3 tests/run.py \
  --baseline-dir /absolute/read-only/build-tools/resources/egress-guard \
  --evidence /absolute/new/evidence-directory
```

The runner copies baseline source, compiles only into a private `/tmp` directory,
uses loopback peers, and deletes only its freshly created build directory after
retaining logs/results outside the repo. Caller work directories are not accepted.
It first establishes sockets in today's guard's log mode, uses a test-only setter
to enable its cached block mode, verifies new connects are refused, and then
demonstrates the old-socket gap. Behavior tests classify one loopback test peer as
remote in both libraries; benchmarks use unmodified classification. `--skip-benchmark`
runs behavior checks only. Performance compares no guard, today's guard, resident
pass-through and resident block in randomized paired rounds.

The controller fixture changes policy through the actual helper while one live
guard retains its TCP/UDP sockets. This checks that process's observation, not
all-process observation or draining. A separate short mapped-IPv6 TCP test checks
zero-filled classification with denied and permitted loopback cases.

Run the runner's cleanup tests without clang or networking:

```sh
python3 tests/runner_test.py
```

Results are **macOS host mechanism only**. Measurable pass-through regression
against no guard, or block regression against today's guard, stops integration.
Warm readiness must eventually self-check resident image/control state and fall
back cold on failure. All-process enforcement acknowledgement, loader wiring,
Simulator validation, packaging, proxy readiness and hosted acceptance remain
separate gates.
