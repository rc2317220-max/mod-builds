# Preview 4 Turbo compiler

The original Android v1 protocol is unchanged. The game still receives one optimized ARM64 JNI library with the exact same commit and manifest identity, through the existing Worker. No APK is built.

The verified Turbo cache warms the exact pinned source with invariant patches already applied to the package runtime and the Android entrypoint. A non-linked workspace marker makes the mod glob valid. Per-request registry code resides in the Android crate, away from the game-client sources. The sandbox creates mods and their dependencies in a disposable overlay, with no network, privileges or writable shared cache. Only the trusted base workflow saves the cache.

The original base cache and original compiler implementation remain an automatic fallback on a Turbo cache miss. The legacy scripts are preserved separately so an experimental patch cannot change that path. Production looks up the exact Turbo key based on the relevant scripts. The Turbo workflow runs two distinct real ARM64 probes and saves the new cache only after both pass the ELF/hash/inventory checks and the 20% improvement gate versus the previously observed 603-second Cargo build. Reports are retained as workflow artifacts. Results may differ with mod dependency features and runner contention. The optimization profile remains fast (opt-level 3, no incremental, same NDK and build identity). Dynamic library compatibility, TLS, stripping and validation are unchanged. SCCache and incremental mode are intentionally not enabled without separate evidence.

If the Turbo test fails, diagnose cargo-timing.html and logs; the existing original cache continues serving requests. Neither worker deployment nor phone configuration needs to change.
