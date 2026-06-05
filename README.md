# Minimal Turbo Watch Repro

This is a minimal reproducible example for a `turbo watch` restart caused by writes under a gitignored `.ignored-watch-stress/` directory.

The POC intentionally has no secondary file watcher. A persistent Turbo task runs a plain Node wrapper, and that wrapper starts one child Node process. If the wrapper and child restart after writes only under `.ignored-watch-stress/`, the restart came from Turbo.

## What It Proves

- `turbo watch` can receive a write flood from a gitignored directory.
- Under enough event pressure, Turbo logs watcher lag warnings.
- In Turbo `2.9.16`, the lag fallback loses the concrete changed paths and promotes the change set to "all files changed".
- Once the concrete paths are gone, `.gitignore` filtering can no longer exclude `.ignored-watch-stress/`.
- Turbo performs a full watch rebuild and restarts the interruptible persistent `dev` task.

## Structure

- `turbo.json` defines one cacheable `dev:bundle` task and one persistent interruptible `dev` task.
- `apps/core/scripts/dev-bundle.js` copies `apps/core/src/child-template.js` to `apps/core/out/dev-build/child.js`.
- `apps/core/scripts/dev-wrapper.js` starts `node out/dev-build/child.js` directly and forwards stop signals.
- `scripts/stress.js` writes only under `.ignored-watch-stress/generated-files/...`.
- `vendor/turborepo` is a git submodule pinned to Turbo `v2.9.16`.

## Environment

The verified repro used:

- Node: `26.3.0`
- npm: `11.16.0`
- Turbo: `2.9.16`

`package.json` intentionally uses exact dependency versions.

## Reproduce

Install dependencies:

```sh
npm install
```

Start Turbo watch:

```sh
npm run dev
```

In another shell, flood the gitignored directory:

```sh
npm run stress
```

The stress script defaults to 20,000 files of 2 KiB each. If the local filesystem does not reproduce, raise the event count:

```sh
POC_STRESS_DIRS=1000 POC_STRESS_FILES_PER_DIR=40 npm run stress
```

Clean generated files:

```sh
npm run clean
```

## Expected Signal

The repro is successful when the `npm run dev` shell prints output like:

```text
WARNING file event lagged
[core wrapper] received SIGINT; forwarding to child group
[child] received SIGINT
apps-core:dev:bundle: cache hit
apps-core:dev: cache bypass, force executing
[core wrapper] pid=<new pid>
[child] pid=<new pid>
```

The important parts are:

- Turbo emits `WARNING file event lagged`.
- The wrapper receives a stop signal from Turbo.
- The child receives the forwarded signal.
- Turbo replays the cacheable `dev:bundle` task.
- Turbo force-executes the persistent `dev` task again with new process IDs.

## Verified Result

Verified on 2026-06-05 with the default stress settings.

Stress wrote only under:

```text
.ignored-watch-stress/generated-files/<job-id>/sample-target/
```

Stress stats:

```text
files=20000 totalBytes=40960000 concurrency=128 durationMs=1068
```

Turbo emitted:

```text
WARNING file event lagged
```

The direct Node wrapper emitted:

```text
[core wrapper] received SIGINT; forwarding to child group pid=271
[core wrapper] child exited code=0 signal=null durationMs=32967
```

The child process emitted:

```text
[child] received SIGINT uptimeMs=32932
[child] exit code=0 uptimeMs=32942
```

Turbo then replayed the cacheable prerequisite and restarted the persistent task:

```text
apps-core:dev:bundle: cache hit (outputs already on disk), replaying logs
apps-core:dev: cache bypass, force executing
[core wrapper] pid=405
[child] pid=412
```

Because there is no secondary file watcher in this POC, the restart can only come from Turbo.

## Root Cause

Turbo receives raw filesystem events before it applies `.gitignore` filtering. Under the write flood, Turbo's internal event receiver lags. In Turbo `2.9.16`, the lag fallback replaces the concrete changed-file list with `ChangedFiles::All`.

That happens here:

[`vendor/turborepo/crates/turborepo-lib/src/package_changes_watcher.rs`](vendor/turborepo/crates/turborepo-lib/src/package_changes_watcher.rs#L434-L440)

```rust
Err(broadcast::error::RecvError::Lagged(_)) => {
    tracing::warn!("file event lagged");
    // Lagged essentially means we're not keeping up with
    // the file events, so
    // we can catch up by declaring all files changed
    *self.changed_files.lock().await.borrow_mut() = ChangedFiles::All;
}
```

The normal path would collect concrete event paths into a trie:

[`vendor/turborepo/crates/turborepo-lib/src/package_changes_watcher.rs`](vendor/turborepo/crates/turborepo-lib/src/package_changes_watcher.rs#L414-L420)

```rust
Ok(Ok(Event { paths, .. })) => {
    if let ChangedFiles::Some(trie) =
        self.changed_files.lock().await.borrow_mut().deref_mut()
    {
        for path in paths {
            if let Some(path) = path.to_str() {
                trie.insert(path.to_string(), ());
```

With concrete paths, Turbo later filters out ignored files:

[`vendor/turborepo/crates/turborepo-lib/src/package_changes_watcher.rs`](vendor/turborepo/crates/turborepo-lib/src/package_changes_watcher.rs#L181-L198)

```rust
let changed_files: HashSet<_> = trie
    .keys()
    .filter_map(|p| {
        let p = match AbsoluteSystemPathBuf::new(p) {
            Ok(p) => p,
            Err(_) => {
                tracing::warn!(%p, "skipping non-absolute path from file watcher");
                return None;
            }
        };
        repo_root.anchor(p).ok()
    })
    .filter(|p| !(ancestors_is_ignored(root_gitignore, p) || is_in_git_folder(p)))
    .collect();

if changed_files.is_empty() {
    return FileChangeAction::NoRelevantChanges;
}
```

The bug is that the lag fallback has already discarded those paths. There is no path list left for the `.gitignore` filter to examine.

The `ChangedFiles::All` fallback then triggers rediscovery:

[`vendor/turborepo/crates/turborepo-lib/src/package_changes_watcher.rs`](vendor/turborepo/crates/turborepo-lib/src/package_changes_watcher.rs#L519-L521)

```rust
let ChangedFiles::Some(trie) = changed_files else {
    rediscover!(self, repo_state, root_gitignore, change_mapper);
    continue;
};
```

That `Rediscover` event becomes `ChangedPackages::All`:

[`vendor/turborepo/crates/turborepo-lib/src/run/watch.rs`](vendor/turborepo/crates/turborepo-lib/src/run/watch.rs#L507-L510)

```rust
PackageChangeEvent::Rediscover => {
    *changed_packages
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = ChangedPackages::All;
}
```

The full-change path stops active/background tasks:

[`vendor/turborepo/crates/turborepo-lib/src/run/watch.rs`](vendor/turborepo/crates/turborepo-lib/src/run/watch.rs#L430-L438)

```rust
ChangedPackages::All => {
    for stopper in self.background_stoppers.drain(..) {
        stopper.stop().await;
    }
    for handle in self.active_runs.drain(..) {
        handle.stopper.stop().await;
        let _ = handle.run_task.await;
    }
}
```

Then Turbo rebuilds the run from scratch without passing a concrete changed-file set:

[`vendor/turborepo/crates/turborepo-lib/src/run/watch.rs`](vendor/turborepo/crates/turborepo-lib/src/run/watch.rs#L637-L674)

```rust
ChangedPackages::All => {
    let mut opts = self.base.opts().clone();
    // ...
    let mut run_builder = RunBuilder::new(base.clone(), None)?
        .with_output_watcher(self.output_watcher.clone());
    // ...
    let (run, _analytics) = run_builder
        .build(&self.handler, self.telemetry.clone())
        .await?;
    self.run = run.into();
    // ...
    Ok(RunHandle {
        stopper: run.stopper(),
        run_task: tokio::spawn(async move { run.run(ui_sender, true).await }),
    })
}
```

This POC's `dev` task is explicitly restartable by Turbo:

[`turbo.json`](turbo.json#L20-L22)

```json
"cache": false,
"persistent": true,
"interruptible": true
```

So the full-change path is allowed to stop and restart it.

## Related Watcher Warning

Another watcher component has a similar lag warning and rediscovery fallback:

[`vendor/turborepo/crates/turborepo-filewatch/src/package_watcher.rs`](vendor/turborepo/crates/turborepo-filewatch/src/package_watcher.rs#L271-L274)

```rust
Err(RecvError::Lagged(count)) => {
    tracing::warn!("lagged behind {count} processing file watching events");
    self.bump_or_queue_rediscovery(&mut state, &package_state_tx);
}
```

Real-world logs may therefore show either:

```text
WARNING file event lagged
```

or:

```text
WARNING lagged behind N processing file watching events
```

Both indicate that Turbo fell behind while processing filesystem events.

## Why Task Inputs Are Not Enough In This Path

Turbo has task-level watch filtering behind `futureFlags.watchUsingTaskInputs`, but it requires a concrete `changed_files` set:

[`vendor/turborepo/crates/turborepo-lib/src/run/builder.rs`](vendor/turborepo/crates/turborepo-lib/src/run/builder.rs#L1019-L1045)

```rust
let watch_task_filtered = if let Some(ref changed_files) = self.changed_files_for_watch {
    if self.opts.future_flags.watch_using_task_inputs && !changed_files.is_empty() {
        let existing_files: std::collections::HashSet<_> = changed_files
            .iter()
            .filter(|f| self.repo_root.resolve(f).exists())
            .cloned()
            .collect();

        let affected_tasks = crate::task_change_detector::affected_task_ids(
            &engine,
            pkg_dep_graph,
            &existing_files,
            &root_turbo_json.global_deps,
        );
        engine = engine.retain_affected_tasks(&affected_tasks);
        true
    } else {
        false
    }
} else {
    false
};
```

In the lag fallback path, the concrete changed-file list has already been replaced by `ChangedFiles::All`, and the later `ChangedPackages::All` rebuild does not call `.with_changed_files(...)`. That means task-input exclusions cannot rescue this specific path after the lag fallback has fired.

## Failure Chain

```text
ignored-dir write flood
-> Turbo raw watcher receiver lags
-> concrete paths are replaced with ChangedFiles::All
-> .gitignore filtering cannot exclude the ignored directory
-> Turbo emits Rediscover / ChangedPackages::All
-> Turbo stops active interruptible persistent tasks
-> Turbo rebuilds the run
-> dev:bundle is replayed from cache
-> dev is force-executed with new wrapper and child process IDs
```
